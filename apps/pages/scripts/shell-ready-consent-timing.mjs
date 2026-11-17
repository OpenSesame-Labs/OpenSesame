#!/usr/bin/env node
/**
 * Playwright consent timing with stalled plan activation (VITE_VERIFY_ACTIVATION_DELAY_MS).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalIamRig } from "./lib/local-iam-rig.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { expect } from "./lib/patient-expect.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const pagesRoot = resolve(here, "..");

const ACTIVATION_DELAY_MS = Number(process.env.VITE_VERIFY_ACTIVATION_DELAY_MS ?? 2_500);
const SAMPLE_MS = Number(process.env.SHELL_READY_CONSENT_SAMPLE_MS ?? 400);

export async function captureConsentActivationTiming({ distDir, label, outDir }) {
  mkdirSync(outDir, { recursive: true });
  const origin = "https://opensesame-labs.github.io";
  const base = "/OpenSesame/";
  const rp = "https://rp.example.test";
  const issuerUrl = `${origin}${base}identity/authorize`;
  const harness = createHarness({ dist: distDir, origin, base, out: outDir });
  const { browser, seedJourney, openConsent } = await createLocalIamRig({
    harness,
    origin,
    rp,
    issuerUrl,
    captures: { path: () => outDir },
  });
  try {
    const { page, context, credentials } = await seedJourney(false);
    const opening = context.waitForEvent("page");
    await page.getByRole("button", { name: "Sign in locally", exact: true }).click();
    const popup = await opening;
    await popup.setViewportSize({ width: 1280, height: 900 });
    const password = popup.getByLabel("Password", { exact: true });
    await expect(password).toBeVisible();
    await password.fill("Cedar-lantern-47-river!");
    await password.press("Enter");
    await popup.waitForTimeout(SAMPLE_MS);
    const pre = await popup.evaluate(() => ({
      consentHeading:
        [...document.querySelectorAll("h1,h2")].some((n) =>
          /Sign in to Test application|Authorize agent/.test(n.textContent ?? ""),
        ),
      vaultSkeleton: Boolean(document.querySelector(".vault-skeleton")),
      shellReadyAttr: document.documentElement.getAttribute("data-shell-ready"),
    }));
    await popup.screenshot({ path: join(outDir, `${label}-pre-activation.png`) });
    await popup.waitForTimeout(
      Math.max(0, ACTIVATION_DELAY_MS - SAMPLE_MS + 200),
    );
    const post = await popup.evaluate(() => ({
      consentHeading:
        [...document.querySelectorAll("h1,h2")].some((n) =>
          /Sign in to Test application|Authorize agent/.test(n.textContent ?? ""),
        ),
      vaultSkeleton: Boolean(document.querySelector(".vault-skeleton")),
    }));
    await popup.screenshot({ path: join(outDir, `${label}-post-activation.png`) });
    writeFileSync(
      join(outDir, `${label}-timing.json`),
      JSON.stringify({ activationDelayMs: ACTIVATION_DELAY_MS, sampleMs: SAMPLE_MS, pre, post }, null, 2),
    );
    return { pre, post };
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dist = process.argv[2];
  const label = process.argv[3] ?? "run";
  const out =
    process.env.SHELL_READY_TIMING_OUT ?? join(pagesRoot, "artifacts/consent-timing");
  if (!dist) {
    console.error("usage: shell-ready-consent-timing.mjs <distDir> [label]");
    process.exit(2);
  }
  captureConsentActivationTiming({ distDir: dist, label, outDir: join(out, label) }).catch(
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}