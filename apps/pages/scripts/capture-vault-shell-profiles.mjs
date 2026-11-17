#!/usr/bin/env node
/**
 * Capture one vault-shell PNG per install profile (Features panel or vault chrome).
 * Each profile must produce a non-identical composite digest vs the others.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertLocalPage,
  captureChoice,
  proofShot,
} from "../../../scripts/ci/pwa-profile-proof-capture.mjs";
import { findChromium } from "./duress/find-chromium.mjs";
import { awaitCapabilitySections } from "./lib/always-on.mjs";
import { openSettingsCategory } from "./lib/pages-journey.mjs";
import {
  createHarness,
  serveLoopbackDist,
} from "./lib/static-origin-harness.mjs";
import {
  buildDist,
  resolveWalks,
} from "./lib/verification-checklist-profiles.mjs";
import {
  applySetupChoice,
  enterVault,
  openDoor,
} from "./lib/verification-checklist-setup.mjs";
import { BASE, emptyRecord } from "./lib/verification-checklist-shot.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const pagesRoot = resolve(here, "..");
const scriptsDir = resolve(pagesRoot, "scripts");

function digestFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function captureVaultShellProfiles({ outDir }) {
  mkdirSync(outDir, { recursive: true });
  const discovery = findChromium();
  if (!discovery.path) throw new Error("no chromium for vault-shell profiles");
  process.env.PLAYWRIGHT_CHROMIUM = discovery.path;
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ executablePath: discovery.path });
  const profilesDir = join(pagesRoot, "capability-profiles");
  const walks = resolveWalks(profilesDir);
  const manifests = [];
  const pngPaths = [];

  for (const walk of walks) {
    const out = join(pagesRoot, "dist-profiles", "vault-shell", walk.buildKey);
    buildDist({
      appRoot: pagesRoot,
      scriptsDir,
      outDir: out,
      capabilityProfile: walk.capabilityProfile,
    });
    const dist = out;
    const server = await serveLoopbackDist({ dist, base: BASE });
    const stepsDir = join(outDir, walk.name);
    mkdirSync(stepsDir, { recursive: true });
    const harness = createHarness({
      dist,
      origin: server.origin,
      base: BASE,
      out: stepsDir,
    });
    const { page } = await harness.newPage(browser, {
      passthrough: [server.origin],
    });
    const record = emptyRecord(walk);
    const texts = new Map();
    const shot = proofShot(page, stepsDir, texts, record);
    await openDoor(page, shot, record, server.href);
    assertLocalPage(page, walk.name);
    await captureChoice(page, walk, stepsDir);
    const where = await applySetupChoice(page, shot, record, walk.setupChoice);
    await enterVault(page, where);
    await openSettingsCategory(page, "Features");
    const panel = page.locator("[data-testid=features-panel]");
    await panel.waitFor({ state: "visible", timeout: 30_000 });
    await awaitCapabilitySections(page);
    const vaultPng = join(outDir, `${walk.name}.png`);
    await panel.screenshot({ path: vaultPng, animations: "disabled" });
    pngPaths.push(vaultPng);
    manifests.push({
      profile: walk.name,
      path: vaultPng,
      sha256: digestFile(vaultPng),
    });
    await page.close();
    await server.close();
  }
  await browser.close();
  const unique = new Set(manifests.map((m) => m.sha256));
  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(
      { profiles: manifests, uniqueDigests: unique.size },
      null,
      2,
    ),
  );
  if (unique.size !== manifests.length) {
    throw new Error(
      `vault-shell profile PNGs must not be byte-identical across profiles (saw ${unique.size} unique of ${manifests.length})`,
    );
  }
  return manifests;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir =
    process.env.VAULT_SHELL_PROFILE_OUT ??
    join(pagesRoot, "../../artifacts/vault-shell-profiles");
  captureVaultShellProfiles({ outDir }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
