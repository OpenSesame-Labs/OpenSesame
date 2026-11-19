#!/usr/bin/env node
/**
 * Playwright evidence for the user-token fingerprint label (`UserTokenPanel`).
 * Walks minimal-local, default, custom, and full capability profiles.
 *
 *   node apps/pages/scripts/capture-user-token-fingerprint-label.mjs --phase after
 *   node apps/pages/scripts/capture-user-token-fingerprint-label.mjs --phase before
 *
 * `before` briefly checks out the signed parent label (`sha256:`) via git show,
 * builds stock dist once, then restores the working tree.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { findChromium } from "./duress/find-chromium.mjs";
import {
  buildDist,
  resolveWalks,
} from "./lib/verification-checklist-profiles.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const repoRoot = path.resolve(appRoot, "../..");
const profilesDir = path.join(appRoot, "capability-profiles");
const panelRel =
  "apps/pages/src/sections/connections/connect/UserTokenPanel.tsx";
const panelPath = path.join(repoRoot, panelRel);

const phaseArg = process.argv.indexOf("--phase");
const phase = phaseArg === -1 ? "after" : process.argv[phaseArg + 1];
if (!["before", "after"].includes(phase)) {
  console.error("usage: --phase before|after");
  process.exit(2);
}

const outRoot = path.join(
  repoRoot,
  "docs/evidence/user-token-fingerprint-label/pages/web",
  phase,
);

function runBeforeLabelPatch() {
  const saved = fs.readFileSync(panelPath, "utf8");
  const old = execFileSync(
    "git",
    ["show", "51b7c83969120aec0f35559984dfd280d1613d98:" + panelRel],
    { cwd: repoRoot, encoding: "utf8" },
  );
  fs.writeFileSync(panelPath, old);
  return () => fs.writeFileSync(panelPath, saved);
}

async function captureProfile(walk, distDir, harness) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route("**/api/connect/**", async (route) => {
    const url = route.request().url();
    if (url.endsWith("/api/connect/connector/read")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          connector: {
            id: "scl_evidence",
            uid: "resend/wedding",
            type: "oauth",
            data: {},
          },
        }),
      });
    }
    if (url.endsWith("/api/connect/token-check")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          subject: "user",
          expiresAt: 1_900_000_000_000,
          scopes: ["emails:send"],
          fingerprint: "0123456789ab",
          verified: { status: 200, ok: true, account: "wedding.example" },
        }),
      });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
  const origin = harness.originFor(distDir);
  await page.goto(`${origin}/OpenSesame/#/connections/resend`, {
    waitUntil: "networkidle",
  });
  const testButton = page.getByRole("button", { name: "Test user token" });
  if (await testButton.isVisible().catch(() => false)) {
    await testButton.click();
    const label =
      phase === "before" ? "sha256:0123456789ab…" : "scrypt:0123456789ab…";
    await page.getByText(label).waitFor({ timeout: 60_000 });
    const shotDir = path.join(outRoot, walk.name);
    fs.mkdirSync(shotDir, { recursive: true });
    await page.screenshot({
      path: path.join(shotDir, "user-token-fingerprint-label.png"),
      fullPage: false,
    });
    console.error(`[user-token-label] ${walk.name} ${phase} ok`);
  } else {
    console.error(
      `[user-token-label] ${walk.name} skipped (connect panel not in profile build)`,
    );
  }
  await browser.close();
}

function prepareChromium() {
  const discovery = findChromium();
  if (!discovery.path) {
    console.error("[user-token-label] no Chromium binary");
    process.exit(2);
  }
  process.env.PLAYWRIGHT_CHROMIUM = discovery.path;
}

async function main() {
  prepareChromium();
  const restore =
    phase === "before" ? runBeforeLabelPatch() : () => undefined;
  try {
    const walks = resolveWalks(profilesDir);
    const built = new Map();
    for (const walk of walks) {
      const distDir = buildDist({
        appRoot,
        repoRoot,
        name: walk.name,
        buildKey: walk.buildKey,
        capabilityProfile: walk.capabilityProfile,
        built,
      });
      const harness = await createHarness();
      try {
        await captureProfile(walk, distDir, harness);
      } finally {
        await harness.close();
      }
    }
  } finally {
    restore();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});