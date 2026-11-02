#!/usr/bin/env node
/**
 * Build each install profile and capture one composite PNG.
 * Each walk is served from its own dist/ on 127.0.0.1 at /OpenSesame/.
 * The live Pages host is never the navigation target.
 *
 *   node scripts/ci/pwa-install-profile-proof.mjs
 *   VERIFY_SKIP_BUILD=1 node scripts/ci/pwa-install-profile-proof.mjs
 *   PWA_PROFILE_PROOF_NAME=default node scripts/ci/pwa-install-profile-proof.mjs
 *
 * A named profile writes entry.json and skips the four-profile assert.
 * The merge gate runs that assert after every profile artifact lands.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findChromium } from "../../apps/pages/scripts/duress/find-chromium.mjs";
import { awaitCapabilitySections } from "../../apps/pages/scripts/lib/always-on.mjs";
import { openSettingsCategory } from "../../apps/pages/scripts/lib/pages-journey.mjs";
import {
  createHarness,
  serveLoopbackDist,
} from "../../apps/pages/scripts/lib/static-origin-harness.mjs";
import {
  WALK_NAMES,
  appPaths,
  buildDist,
  resolveWalks,
} from "../../apps/pages/scripts/lib/verification-checklist-profiles.mjs";
import {
  applySetupChoice,
  enterVault,
  openDoor,
} from "../../apps/pages/scripts/lib/verification-checklist-setup.mjs";
import {
  BASE,
  emptyRecord,
  visibleClick,
} from "../../apps/pages/scripts/lib/verification-checklist-shot.mjs";
import { isString } from "../lib/json-boundary.mjs";
import {
  assertProfileProof,
  proofManifest,
  readImageWidth,
  stitchPanels,
  widenTo,
} from "./pwa-profile-proof-gate.mjs";
import { walksForProof } from "./pwa-profile-proof-select.mjs";

const outRoot =
  process.env.PWA_PROFILE_PROOF_OUT ??
  join(process.cwd(), "artifacts/pwa-profile-proof");

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function collectFiles(distDir, relativeDir, entries) {
  const absolute = join(distDir, relativeDir);
  for (const name of await readdir(absolute, { withFileTypes: true })) {
    if (name.name === ".install-profile-proof.json") {
      throw new Error(`refusing install-profile marker in ${absolute}`);
    }
    const rel = relativeDir === "" ? name.name : `${relativeDir}/${name.name}`;
    if (name.isDirectory()) await collectFiles(distDir, rel, entries);
    else if (name.isFile()) entries.push(rel);
  }
}

async function sha256DistTree(distDir) {
  const entries = [];
  await collectFiles(distDir, "", entries);
  entries.sort();
  const hash = createHash("sha256");
  for (const rel of entries) {
    hash.update(rel);
    hash.update("\0");
    hash.update(await readFile(join(distDir, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function prepareChromium() {
  const discovery = findChromium();
  if (!discovery.path) {
    console.error("[pwa-proof] no Chromium binary");
    for (const probed of discovery.probed) console.error(`  ${probed}`);
    process.exit(2);
  }
  process.env.PLAYWRIGHT_CHROMIUM = discovery.path;
  console.error(
    `[pwa-proof] chromium ${discovery.path} (${discovery.source}) ${discovery.version ?? ""}`,
  );
}

function buildsNeeded(walks) {
  const byKey = new Map();
  for (const walk of walks) {
    if (!byKey.has(walk.buildKey)) byKey.set(walk.buildKey, walk);
  }
  return [...byKey.values()];
}

async function removeMarker(dist) {
  const marker = join(dist, ".install-profile-proof.json");
  if (!existsSync(marker)) return;
  await rm(marker);
  console.error(`[pwa-proof] removed ${marker}`);
}

async function prepareOut(root) {
  await mkdir(root, { recursive: true });
  await rm(join(root, "dist"), { recursive: true, force: true });
  for (const name of await readdir(root)) {
    if (
      name.endsWith(".png") ||
      name === "manifest.json" ||
      name === "entry.json"
    ) {
      await rm(join(root, name), { force: true });
    }
  }
}

async function buildAll(walks, paths) {
  const dists = new Map();
  const digests = new Map();
  for (const walk of buildsNeeded(walks)) {
    const outDir = join(
      paths.appRoot,
      "dist-profiles",
      "pwa-proof",
      walk.buildKey,
    );
    buildDist({
      appRoot: paths.appRoot,
      scriptsDir: paths.scriptsDir,
      outDir,
      capabilityProfile: walk.capabilityProfile,
    });
    await removeMarker(outDir);
    const digest = await sha256DistTree(outDir);
    dists.set(walk.buildKey, outDir);
    digests.set(walk.buildKey, digest);
    console.error(`[pwa-proof] dist ${walk.buildKey} ${digest}`);
  }
  return { dists, digests };
}

function proofShot(page, dir, texts, record) {
  return async function shot(step) {
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.waitForTimeout(300);
    const file = join(dir, `${step}.png`);
    await page.screenshot({ path: file, animations: "disabled" });
    const text = await page.evaluate(() => document.body.innerText);
    texts.set(step, text);
    record.shots.push(step);
    return text;
  };
}

function textOf(texts, step) {
  const value = texts.get(step);
  return isString(value) ? value : "";
}

function requireCeremony(texts) {
  const ceremony = textOf(texts, "setup-capabilities");
  if (ceremony.includes("Use the minimal configuration")) return;
  throw new Error(
    `custom capabilities ceremony missing; saw: ${ceremony.slice(0, 500)}`,
  );
}

async function captureChoice(page, walk, stepsDir) {
  const opened = await visibleClick(page, "button", "Set up your own");
  if (!opened) throw new Error(`${walk.name}: Set up your own did not appear`);
  const choice = page.getByRole("button", {
    name: walk.setupChoice,
    exact: true,
  });
  await choice.waitFor({ state: "visible", timeout: 15_000 });
  await choice.scrollIntoViewIfNeeded();
  const path = join(stepsDir, "setup-choice.png");
  await choice.screenshot({ path, animations: "disabled" });
  return path;
}

async function captureFeatures(page, shot, where) {
  await enterVault(page, where);
  await openSettingsCategory(page, "Features");
  const panel = page.locator("[data-testid=features-panel]");
  await panel.waitFor({ state: "visible", timeout: 15_000 });
  await awaitCapabilitySections(page);
  const switchesOn = await panel
    .locator('[role="switch"][aria-checked="true"]')
    .count();
  await page.setViewportSize({ width: 1280, height: 2200 });
  await shot("features");
  return switchesOn;
}

async function finishProfile(page, shot, walk, where, texts) {
  if (walk.setupChoice === "Custom") {
    requireCeremony(texts);
    return { distinguish: "setup-capabilities", ceremonyReached: true };
  }
  const switchesOn = await captureFeatures(page, shot, where);
  return { distinguish: "features", switchesOn, ceremonyReached: false };
}

const LIVE_PAGES = "https://opensesame-labs.github.io";

function assertLocalPage(page, name) {
  const url = page.url();
  if (url.startsWith(LIVE_PAGES)) {
    throw new Error(`${name} navigated to live Pages: ${url}`);
  }
}

async function failureShot(page, root, name) {
  console.error(`[pwa-proof] ${name} failed at ${page.url()}`);
  const failed = join(root, `failure-${name}.png`);
  await page
    .screenshot({ path: failed, animations: "disabled" })
    .catch(() => undefined);
  console.error(`[pwa-proof] ${name} failed; wrote ${failed}`);
}

function requireShot(path) {
  if (!existsSync(path)) throw new Error(`missing screenshot ${path}`);
}

async function composeProfile(walk, stepsDir, root, distinguish) {
  const frontPath = join(stepsDir, "front-door.png");
  const choicePath = join(stepsDir, "setup-choice.png");
  const statePath = join(stepsDir, `${distinguish}.png`);
  requireShot(frontPath);
  requireShot(choicePath);
  requireShot(statePath);
  const choiceHash = await sha256File(choicePath);
  const distinguishHash = await sha256File(statePath);
  await widenTo(choicePath, await readImageWidth(frontPath));
  const pngPath = join(root, `${walk.name}.png`);
  const stateLabel = distinguish === "features" ? "Features" : "Capabilities";
  await stitchPanels(
    [
      { path: frontPath, label: "Front door" },
      { path: choicePath, label: "Setup choice" },
      { path: statePath, label: stateLabel },
    ],
    pngPath,
  );
  return {
    pngHash: await sha256File(pngPath),
    distinguishHash,
    choiceHash,
  };
}

async function proveProfile({ browser, walk, dist, distDigest, root }) {
  const stepsDir = await mkdtemp(join(tmpdir(), "pwa-proof-"));
  const server = await serveLoopbackDist({ dist, base: BASE });
  const harness = createHarness({
    dist,
    origin: server.origin,
    base: BASE,
    out: stepsDir,
  });
  const opened = await harness.newPage(browser, {
    passthrough: [server.origin],
  });
  const texts = new Map();
  const record = emptyRecord(walk);
  const shot = proofShot(opened.page, stepsDir, texts, record);
  opened.page.on("pageerror", (error) => {
    console.error(`[pwa-proof] ${walk.name} pageerror: ${error.message}`);
  });
  try {
    await opened.page.emulateMedia({ reducedMotion: "reduce" });
    await openDoor(opened.page, shot, record, server.href);
    assertLocalPage(opened.page, walk.name);
    await captureChoice(opened.page, walk, stepsDir);
    const where = await applySetupChoice(
      opened.page,
      shot,
      record,
      walk.setupChoice,
    );
    const state = await finishProfile(opened.page, shot, walk, where, texts);
    const hashes = await composeProfile(
      walk,
      stepsDir,
      root,
      state.distinguish,
    );
    return {
      profile: walk.name,
      setupChoice: walk.setupChoice,
      buildKey: walk.buildKey,
      distDigest,
      distinguish: state.distinguish,
      switchesOn: state.switchesOn,
      ceremonyReached: state.ceremonyReached,
      ...hashes,
    };
  } catch (error) {
    await failureShot(opened.page, root, walk.name);
    throw error;
  } finally {
    await opened.context.close();
    await server.close();
    await rm(stepsDir, { recursive: true, force: true });
  }
}

async function launchBrowser(dist, root) {
  const harness = createHarness({
    dist,
    origin: "http://127.0.0.1",
    base: BASE,
    out: root,
  });
  return harness.launch({
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--host-resolver-rules=MAP opensesame-labs.github.io ~NOTFOUND",
    ],
  });
}

function requireBuilt(built, walk) {
  const dist = built.dists.get(walk.buildKey);
  const distDigest = built.digests.get(walk.buildKey);
  if (!isString(dist) || !isString(distDigest)) {
    throw new Error(`missing dist for ${walk.name}`);
  }
  return { dist, distDigest };
}

async function walkAll(walks, built, root) {
  const sample = built.dists.values().next().value;
  if (!isString(sample)) throw new Error("no profile dist");
  const browser = await launchBrowser(sample, root);
  const entries = [];
  try {
    for (const walk of walks) {
      const { dist, distDigest } = requireBuilt(built, walk);
      console.error(`[pwa-proof] walk ${walk.name} (${walk.setupChoice})`);
      entries.push(
        await proveProfile({ browser, walk, dist, distDigest, root }),
      );
      console.error(`[pwa-proof] ${walk.name} png ready`);
    }
  } finally {
    await browser.close();
  }
  return entries;
}

async function main() {
  const paths = appPaths();
  const resolved = resolveWalks(paths.profilesDir, WALK_NAMES);
  const names = resolved.map((walk) => walk.name).join(",");
  if (names !== WALK_NAMES.join(",")) {
    throw new Error(`expected ${WALK_NAMES.join(",")}, got ${names}`);
  }
  const walks = walksForProof(resolved, process.env.PWA_PROFILE_PROOF_NAME);
  await prepareOut(outRoot);
  prepareChromium();
  const built = await buildAll(walks, paths);
  const entries = await walkAll(walks, built, outRoot);
  if (walks.length === 1) {
    await writeFile(
      join(outRoot, "entry.json"),
      `${JSON.stringify(entries[0], null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify(entries[0], null, 2)}\n`);
    return;
  }
  assertProfileProof(entries);
  const manifest = proofManifest(entries);
  await writeFile(
    join(outRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
