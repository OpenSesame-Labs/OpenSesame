#!/usr/bin/env node
/**
 * Setup profiles, minimal confirm, and tutorial pause queue — Playwright proof.
 *
 * Captures named shots under SETUP_PROFILE_OUT (default
 * /opt/cursor/artifacts/setup-profiles): `<build>/<profile>/setup-*.png` and
 * `branch/default/tutorial-*.png`. Builds `origin/main` dist for `main/` when
 * SETUP_PAUSE_MAIN_DIST is unset (work/setup-pause-main-tree).
 *
 *   npm run verify:setup-tutorial-pause -w @opensesame/pages
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { findChromium } from "./duress/find-chromium.mjs";
import { mainPagesDist } from "./lib/setup-pause-main-dist.mjs";
import { runBuildPhase } from "./lib/setup-pause-run-build.mjs";

const devUrl = process.env.SETUP_PAUSE_DEV_URL ?? "";
const ORIGIN = devUrl ? "" : "https://opensesame-labs.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const href = devUrl || `${ORIGIN}${BASE}`;
const outRoot =
  process.env.SETUP_PROFILE_OUT ?? "/opt/cursor/artifacts/setup-profiles";
const here = fileURLToPath(new URL(".", import.meta.url));
const branchDist = process.env.SETUP_PAUSE_DIST
  ? path.resolve(process.env.SETUP_PAUSE_DIST)
  : path.resolve(here, "../dist");

const failures = [];
const evidence = [];

function check(ok, what) {
  if (ok) return;
  failures.push(what);
  console.log(`  FAIL ${what}`);
}

function digest(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const staticHref = `${ORIGIN}${BASE}`;

async function runBuild(browser, { label, dist, expectAdvanced, tutorial }) {
  const phaseDevUrl = label === "branch" ? devUrl : "";
  const href = phaseDevUrl || staticHref;
  return runBuildPhase(
    browser,
    {
      label,
      dist,
      expectAdvanced,
      tutorial,
      devUrl: phaseDevUrl,
      href,
      BASE,
      outRoot,
    },
    { check, digest, evidence, failures },
  );
}

async function main() {
  if (!devUrl && !existsSync(branchDist)) {
    throw new Error(
      `no dist at ${branchDist}; build pages or set SETUP_PAUSE_DEV_URL`,
    );
  }
  mkdirSync(outRoot, { recursive: true });
  const mainDist =
    process.env.SETUP_PAUSE_MAIN_DIST ?? (devUrl ? "" : mainPagesDist());
  if (devUrl && !mainDist) {
    check(
      false,
      "SETUP_PAUSE_DEV_URL requires SETUP_PAUSE_MAIN_DIST or omit dev URL for full main+branch evidence",
    );
  }
  const discovery = findChromium();
  if (!discovery.path) throw new Error("no chromium");
  const browser = await chromium.launch({
    executablePath: discovery.path,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const manifest = { profiles: [], evidence, failures };
  try {
    if (mainDist) {
      manifest.profiles.push(
        ...(await runBuild(browser, {
          label: "main",
          dist: mainDist,
          expectAdvanced: false,
          tutorial: false,
        })),
      );
    }
    manifest.profiles.push(
      ...(await runBuild(browser, {
        label: "branch",
        dist: branchDist,
        expectAdvanced: true,
        tutorial: true,
      })),
    );
    const branchChoices = path.join(outRoot, "branch", "setup-choices.png");
    const mainChoices = path.join(outRoot, "main", "setup-choices.png");
    if (existsSync(branchChoices) && existsSync(mainChoices)) {
      const same = digest(branchChoices) === digest(mainChoices);
      check(!same, "branch setup-choices differs from main");
    }
  } finally {
    await browser.close();
  }
  writeFileSync(
    path.join(outRoot, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
  console.log(`setup tutorial pause ok; shots in ${outRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
