#!/usr/bin/env node
/**
 * Public web-score gate.
 *
 * Measures a deployed URL with Lighthouse and the public Is Agentic report.
 * The gate is intentionally separate from `npm run verify`: it needs the network,
 * a Chrome binary, and the public Is Agentic service, so it is a delivery check
 * for a published site rather than a hermetic unit gate.
 *
 * Usage:
 *   CHROME_PATH=/path/to/chrome node scripts/quality/web-score.mjs [url]
 *
 * Defaults to the OpenSesame app and asserts:
 *   - Lighthouse desktop and mobile: all four categories = 1.0
 *   - Is Agentic for origin-root targets only: score = 100
 *
 * Reports are written to work/web-score/ (git-ignored).
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAgentic } from "../lib/web-score-agentic.mjs";
import { checkAppReady } from "../lib/web-score-app.mjs";
import {
  cleanup,
  cleanupSync,
  startChrome,
  sweepProfiles,
  waitForChrome,
} from "../lib/web-score-browser.mjs";
import {
  discoverChrome,
  originScoreTarget,
  parseTarget,
} from "../lib/web-score-common.mjs";
import { runLighthouse } from "../lib/web-score-lighthouse.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runId = `${process.pid}-${Date.now()}`;
const reportDir = join(repo, "work", "web-score", runId);
const agenticReport = join(reportDir, "is-agentic.json");
const defaultTarget = "https://opensesame-labs.github.io/OpenSesame/";
const agenticOrigin = "https://is-agentic.com";
const lighthouseTimeoutMs = 240_000;

function positiveEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`web-score: ${name} must be a positive integer`);
    process.exit(2);
  }
  return value;
}

const attempts = positiveEnv("WEB_SCORE_LIGHTHOUSE_ATTEMPTS", 1);
const expectApp = process.env.WEB_SCORE_EXPECT_APP !== "0";
const agenticMaxAgeMs = positiveEnv(
  "WEB_SCORE_MAX_AGENTIC_AGE_MS",
  6 * 60 * 60 * 1000,
);

let targetUrl;
try {
  targetUrl = parseTarget(
    process.argv[2] ?? process.env.WEB_SCORE_URL ?? defaultTarget,
  );
} catch (error) {
  console.error(`web-score: ${error.message}`);
  process.exit(2);
}

let chrome;
try {
  chrome = discoverChrome();
} catch (error) {
  console.error(`web-score: ${error.message}`);
  process.exit(2);
}

mkdirSync(reportDir, { recursive: true });
console.log(`Reports: ${reportDir}`);
sweepProfiles();
const profileDir = mkdtempSync(join(tmpdir(), "web-score-"));
const lighthouseReports = ["desktop", "mobile"].map((formFactor) => ({
  formFactor,
  report: join(reportDir, `lighthouse-${formFactor}.json`),
}));
const children = new Set();
let cleanedUp = false;

function shutdown(code) {
  if (cleanedUp) process.exit(code);
  cleanedUp = true;
  cleanupSync(children, profileDir);
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => shutdown(signal === "SIGINT" ? 130 : 143));
}

async function main() {
  let failed = false;
  const agenticTarget = originScoreTarget(targetUrl);
  try {
    if (expectApp) {
      try {
        await checkAppReady({
          chrome,
          targetUrl,
          noSandbox: process.env.WEB_SCORE_NO_SANDBOX === "1",
        });
        console.log("OpenSesame front door: controls respond");
      } catch (error) {
        console.error(`FAIL: OpenSesame front door: ${error.message}`);
        failed = true;
      }
    }
    for (const { formFactor, report } of lighthouseReports) {
      const lighthouse = await runLighthouse({
        targetUrl,
        withBrowser: async (audit) => {
          // Each run models a fresh visitor. A previous audit can leave
          // IndexedDB or a service worker behind even after Lighthouse resets
          // storage, so do not share a Chrome profile between samples.
          const sampleProfile = mkdtempSync(join(profileDir, "sample-"));
          const { child, getError } = startChrome({
            chrome,
            profileDir: sampleProfile,
            noSandbox: process.env.WEB_SCORE_NO_SANDBOX === "1",
            children,
            expectApp,
          });
          try {
            const port = await waitForChrome(sampleProfile, child, getError);
            return await audit(port);
          } finally {
            await cleanup(new Set([child]), sampleProfile);
            children.delete(child);
          }
        },
        reportPath: report,
        timeout: lighthouseTimeoutMs,
        attempts,
        children,
        formFactor,
        expectApp,
      });
      if (!lighthouse.passed) {
        failed = true;
      }
    }

    // Is Agentic scores an origin, not a path. An origin score cannot stand
    // in for this app when it is hosted below someone else's landing page.
    if (agenticTarget) {
      const agentic = await checkAgentic({
        origin: agenticOrigin,
        target: agenticTarget,
        maxAgeMs: agenticMaxAgeMs,
        reportPath: agenticReport,
      });
      console.log(
        `Is Agentic: ${JSON.stringify({
          target: agentic.target,
          score: agentic.score,
          score_label: agentic.score_label,
          scanned_at: agentic.scanned_at,
        })}`,
      );
      if (agentic.score !== 100) {
        console.error(
          `FAIL: Is Agentic score is ${agentic.score}, expected 100`,
        );
        failed = true;
      }
    } else {
      console.log(
        "Is Agentic: skipped; it cannot score the requested path or query",
      );
    }
    if (!failed) {
      console.log(`PASS: web-score checks for ${targetUrl.href}`);
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (!cleanedUp) {
      cleanedUp = true;
      await cleanup(children, profileDir);
    }
  }
  if (failed) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(`web-score: ${error.message}`);
  if (!cleanedUp) {
    cleanedUp = true;
    await cleanup(children, profileDir);
  }
  process.exitCode = 1;
}
