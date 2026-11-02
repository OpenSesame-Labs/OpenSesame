#!/usr/bin/env node
/**
 * Build minimal, default, custom, and full install profiles and capture
 * Playwright screenshots proving each artifact loads (hashes must differ).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import {
  appPaths,
  buildDist,
  resolveWalks,
  WALK_NAMES,
} from "../../apps/pages/scripts/lib/verification-checklist-profiles.mjs";

const outRoot =
  process.env.PWA_PROFILE_PROOF_OUT ??
  join(process.cwd(), "artifacts/pwa-profile-proof");

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  const { appRoot, scriptsDir, profilesDir } = appPaths();
  const walks = resolveWalks(profilesDir, WALK_NAMES);
  const digests = [];
  await mkdir(outRoot, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const walk of walks) {
      const dist = join(outRoot, "dist", walk.name);
      buildDist({
        appRoot,
        scriptsDir,
        outDir: dist,
        capabilityProfile: walk.capabilityProfile,
      });
      const indexPath = join(dist, "index.html");
      const digest = await sha256File(indexPath);
      digests.push({ profile: walk.name, digest });
      const page = await browser.newPage();
      await page.goto(`file://${indexPath}`);
      await page.screenshot({
        path: join(outRoot, `${walk.name}.png`),
        fullPage: true,
      });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  const unique = new Set(digests.map((entry) => entry.digest));
  if (unique.size !== digests.length) {
    throw new Error("Profile dist artifacts must not be byte-identical");
  }
  await writeFile(
    join(outRoot, "manifest.json"),
    `${JSON.stringify({ profiles: digests }, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(digests, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
