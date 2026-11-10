#!/usr/bin/env node
/**
 * Build each install profile and capture one composite PNG.
 * Each walk is served from its own dist/ on 127.0.0.1 at /OpenSesame/.
 * The live Pages host is never the navigation target.
 *
 *   node scripts/ci/pwa-install-profile-proof.mjs
 *   VERIFY_SKIP_BUILD=1 node scripts/ci/pwa-install-profile-proof.mjs
 *   PWA_PROFILE_PROOF_NAME=full node scripts/ci/pwa-install-profile-proof.mjs
 *
 * CD and pull-request workflows set PWA_PROFILE_PROOF_NAME=full only.
 * A named profile writes full.png and manifest.json after assertFullProfileProof.
 * An empty name keeps every walk for local runs and runs the four-profile assert.
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
  openDoor,
} from "../../apps/pages/scripts/lib/verification-checklist-setup.mjs";
import {
  BASE,
  emptyRecord,
} from "../../apps/pages/scripts/lib/verification-checklist-shot.mjs";
import { isString, readString } from "../lib/json-boundary.mjs";
import {
  assertLocalPage,
  captureChoice,
  composeProfile,
  failureShot,
  finishProfile,
  proofShot,
} from "./pwa-profile-proof-capture.mjs";
import {
  assertFullProfileProof,
  assertProfileProof,
  proofManifest,
} from "./pwa-profile-proof-gate.mjs";
import {
  FULL_INSTALL_PROFILE_PROOF_NAME,
  walksForProof,
} from "./pwa-profile-proof-select.mjs";

const outRoot =
  process.env.PWA_PROFILE_PROOF_OUT ??
  join(process.cwd(), "artifacts/pwa-profile-proof");

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
  const proofDistRaw = readString(process.env.PWA_PROFILE_PROOF_DIST);
  if (proofDistRaw !== undefined && proofDistRaw.length > 0) {
    if (
      walks.length !== 1 ||
      walks[0]?.name !== FULL_INSTALL_PROFILE_PROOF_NAME
    ) {
      throw new Error(
        "PWA_PROFILE_PROOF_DIST is only for the full CD profile proof",
      );
    }
    const walk = walks[0];
    const dist = resolve(proofDistRaw);
    if (!existsSync(join(dist, "index.html"))) {
      throw new Error(`PWA_PROFILE_PROOF_DIST missing index.html: ${dist}`);
    }
    await removeMarker(dist);
    const digest = await sha256DistTree(dist);
    const dists = new Map([[walk.buildKey, dist]]);
    const digests = new Map([[walk.buildKey, digest]]);
    console.error(`[pwa-proof] reuse dist ${walk.buildKey} ${digest}`);
    return { dists, digests };
  }
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
  const started = Date.now();
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
  if (
    walks.length === 1 &&
    walks[0]?.name === FULL_INSTALL_PROFILE_PROOF_NAME
  ) {
    assertFullProfileProof(entries);
    const manifest = proofManifest(entries);
    await writeFile(
      join(outRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    console.error(
      `[pwa-proof] finished in ${Date.now() - started}ms (screenshot-only=${readString(process.env.PWA_PROFILE_PROOF_DIST) !== undefined})`,
    );
    return;
  }
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
