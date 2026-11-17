#!/usr/bin/env node
/**
 * Playwright consent timing with stalled plan activation (VITE_VERIFY_ACTIVATION_DELAY_MS).
 * Samples during vault unlock, not only after IAM password entry.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertLocalPage,
  proofShot,
} from "../../../scripts/ci/pwa-profile-proof-capture.mjs";
import { findChromium } from "./duress/find-chromium.mjs";
import { PIN, sealWithPin } from "./lib/pages-journey.mjs";
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
  openDoor,
} from "./lib/verification-checklist-setup.mjs";
import { BASE, emptyRecord } from "./lib/verification-checklist-shot.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const pagesRoot = resolve(here, "..");

const ACTIVATION_DELAY_MS = Number(
  process.env.VITE_VERIFY_ACTIVATION_DELAY_MS ?? 2_500,
);
const SAMPLE_MS = Number(process.env.SHELL_READY_CONSENT_SAMPLE_MS ?? 450);

async function sampleConsent(page) {
  return page.evaluate(() => ({
    consentHeading: [...document.querySelectorAll("h1,h2")].some((n) =>
      /Sign in to Test application|Authorize agent/.test(n.textContent ?? ""),
    ),
    consentStub: Boolean(
      document.body?.textContent?.includes("consent screen"),
    ),
    vaultSkeleton: Boolean(document.querySelector(".vault-skeleton")),
    shellReadyAttr: document.documentElement.getAttribute("data-shell-ready"),
    path: location.pathname,
  }));
}

export async function captureConsentActivationTiming({
  distDir,
  label,
  outDir,
  walk = { name: "default", setupChoice: "Default" },
}) {
  mkdirSync(outDir, { recursive: true });
  const discovery = findChromium();
  if (!discovery.path) throw new Error("no chromium");
  process.env.PLAYWRIGHT_CHROMIUM = discovery.path;
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const server = await serveLoopbackDist({ dist: distDir, base: BASE });
  const harness = createHarness({
    dist: distDir,
    origin: server.origin,
    base: BASE,
    out: outDir,
  });
  try {
    const { page } = await harness.newPage(browser, {
      passthrough: [server.origin],
    });
    const record = emptyRecord(walk);
    const texts = new Map();
    const shot = proofShot(page, outDir, texts, record);
    await openDoor(page, shot, record, server.href);
    assertLocalPage(page, walk.name);
    await applySetupChoice(page, shot, record, walk.setupChoice);
    await sealWithPin(page);
    await page.getByRole("button", { name: "Lock vault" }).first().click();
    await page.getByLabel("PIN", { exact: true }).waitFor({ timeout: 20_000 });
    await page.getByLabel("PIN", { exact: true }).fill(PIN);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    const authorize = `${server.origin}${BASE}identity/authorize?response_type=code&client_id=local&state=verify-timing&redirect_uri=${encodeURIComponent(`${server.origin}${BASE}`)}`;
    await Promise.all([
      page.waitForTimeout(SAMPLE_MS),
      page
        .goto(authorize, { waitUntil: "domcontentloaded" })
        .catch(() => undefined),
    ]);
    const pre = await sampleConsent(page);
    await page.screenshot({
      path: join(outDir, `${label}-pre-activation.png`),
    });
    await page.waitForTimeout(
      Math.max(200, ACTIVATION_DELAY_MS - SAMPLE_MS + 300),
    );
    const post = await sampleConsent(page);
    await page.screenshot({
      path: join(outDir, `${label}-post-activation.png`),
    });
    const payload = {
      profile: walk.name,
      activationDelayMs: ACTIVATION_DELAY_MS,
      sampleMs: SAMPLE_MS,
      pre,
      post,
    };
    writeFileSync(
      join(outDir, `${label}-timing.json`),
      JSON.stringify(payload, null, 2),
    );
    await server.close();
    return { pre, post };
  } finally {
    await browser.close();
  }
}

/** Build dist per profile and capture main vs fix timing matrix when wired by the collector. */
export function profileWalksForTiming() {
  const profilesDir = join(pagesRoot, "capability-profiles");
  return resolveWalks(profilesDir);
}

export { buildDist };

if (import.meta.url === `file://${process.argv[1]}`) {
  const dist = process.argv[2];
  const label = process.argv[3] ?? "run";
  const out =
    process.env.SHELL_READY_TIMING_OUT ??
    join(pagesRoot, "artifacts/consent-timing");
  if (!dist) {
    console.error("usage: shell-ready-consent-timing.mjs <distDir> [label]");
    process.exit(2);
  }
  captureConsentActivationTiming({
    distDir: dist,
    label,
    outDir: join(out, label),
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
