#!/usr/bin/env node
/**
 * Playwright evidence for the user-token fingerprint label (`UserTokenPanel`).
 * Profiles: minimal-local, default, custom, full (same checklist matrix as
 * verification-checklist-walk.mjs).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChromium } from "./duress/find-chromium.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import {
  appPaths,
  buildDist,
  resolveWalks,
} from "./lib/verification-checklist-profiles.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
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
    ["show", `51b7c83969120aec0f35559984dfd280d1613d98:${panelRel}`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  fs.writeFileSync(panelPath, old);
  return () => fs.writeFileSync(panelPath, saved);
}

function prepareChromium() {
  const discovery = findChromium();
  if (!discovery.path) {
    console.error("[user-token-label] no Chromium binary");
    process.exit(2);
  }
  process.env.PLAYWRIGHT_CHROMIUM = discovery.path;
}

function buildsNeeded(walks) {
  const byKey = new Map();
  for (const walk of walks) {
    if (!byKey.has(walk.buildKey)) byKey.set(walk.buildKey, walk);
  }
  return [...byKey.values()];
}

async function captureTokenLabel(harness, page, walk) {
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
  await page.goto(`${harness.origin}${harness.base}#/connections/resend`, {
    waitUntil: "networkidle",
  });
  const testButton = page.getByRole("button", { name: "Test user token" });
  if (!(await testButton.isVisible().catch(() => false))) {
    console.error(`[user-token-label] ${walk.name} skipped (no connect UI)`);
    return;
  }
  await testButton.click();
  const label =
    phase === "before" ? "sha256:0123456789ab…" : "scrypt:0123456789ab…";
  await page.getByText(label).waitFor({ timeout: 120_000 });
  const shotDir = path.join(outRoot, walk.name);
  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({
    path: path.join(shotDir, "user-token-fingerprint-label.png"),
    fullPage: false,
  });
  console.error(`[user-token-label] ${walk.name} ${phase} ok`);
}

async function main() {
  prepareChromium();
  const restore = phase === "before" ? runBeforeLabelPatch() : () => undefined;
  const { appRoot, scriptsDir, profilesDir } = appPaths();
  try {
    const walks = resolveWalks(profilesDir);
    const dists = new Map();
    for (const walk of buildsNeeded(walks)) {
      const outDir = path.join(
        appRoot,
        "dist-profiles",
        `user-token-label-${walk.buildKey}`,
      );
      buildDist({
        appRoot,
        scriptsDir,
        outDir,
        capabilityProfile: walk.capabilityProfile,
      });
      dists.set(walk.buildKey, outDir);
    }
    for (const walk of walks) {
      const dist = dists.get(walk.buildKey);
      const harness = createHarness({
        dist,
        origin: process.env.PAGES_ORIGIN ?? "https://opensesame-labs.github.io",
        base: "/OpenSesame/",
        out: path.join(outRoot, walk.name),
      });
      const browser = await harness.launch({
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      try {
        const opened = await harness.newPage(browser);
        await captureTokenLabel(harness, opened.page, walk);
        await opened.context.close();
      } finally {
        await browser.close();
      }
    }
  } finally {
    restore();
  }
}

await main();
