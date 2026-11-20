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
import { sealLocalOnly } from "./lib/pages-journey.mjs";
import { freezeContextRandomness } from "./lib/setup-pause-freeze.mjs";
import { mainPagesDist } from "./lib/setup-pause-main-dist.mjs";
import {
  assertOnSetup,
  assertRoads,
  captureMinimalWarning,
  captureProfilePicker,
  captureTutorialPauseFlow,
  openSetupChoices,
  profileDir,
  shotFrame,
} from "./lib/setup-pause-walk.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const PROFILES = ["minimal", "default", "custom", "full"];

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

async function runBuild(browser, { label, dist, expectAdvanced, tutorial }) {
  if (!existsSync(path.join(dist, "index.html"))) {
    throw new Error(`no dist at ${dist} for build ${label}`);
  }
  const harness = devUrl
    ? null
    : createHarness({
        dist,
        origin: "https://opensesame-labs.github.io",
        base: BASE,
        out: outRoot,
      });
  const opened = harness
    ? await harness.newPage(browser)
    : {
        context: await browser.newContext({
          viewport: { width: 1280, height: 900 },
        }),
        page: null,
      };
  const { context } = opened;
  if (!opened.page) opened.page = await context.newPage();
  const page = opened.page;
  await freezeContextRandomness(context);
  console.log(`build ${label}`);
  await openSetupChoices(page, href);
  await assertOnSetup(page, check);
  await assertRoads(page, check, expectAdvanced);
  const shared = path.join(outRoot, label);
  mkdirSync(shared, { recursive: true });
  const choices = path.join(shared, "setup-choices.png");
  await shotFrame(page, choices);
  check(existsSync(choices), `${label} setup-choices.png written`);
  const records = [];
  const profileHashes = [];
  const profileFingerprints = [];
  const newProfilePage = async () => {
    if (harness) {
      const opened = await harness.newPage(browser);
      await freezeContextRandomness(opened.context);
      return opened;
    }
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    await freezeContextRandomness(context);
    const page = await context.newPage();
    return { context, page };
  };
  for (const id of PROFILES) {
    const dir = profileDir(outRoot, label, id);
    const opened = await newProfilePage();
    try {
      const applied = await captureProfilePicker(
        opened.page,
        href,
        dir,
        id,
        check,
      );
      const hash = digest(applied.file);
      profileHashes.push(hash);
      profileFingerprints.push(applied.fingerprint);
      records.push({
        build: label,
        profile: id,
        setupProfileApplied: hash,
        planFingerprint: createHash("sha256")
          .update(applied.fingerprint)
          .digest("hex"),
      });
    } finally {
      await opened.context.close();
    }
  }
  const uniqueShots = new Set(profileHashes);
  check(
    uniqueShots.size >= 3,
    `profile captures differ visually (${uniqueShots.size} unique of ${profileHashes.length})`,
  );
  check(
    new Set(profileFingerprints).size === profileFingerprints.length,
    `each profile leaves a distinct plan fingerprint: ${profileFingerprints.join(" · ")}`,
  );
  if (expectAdvanced) {
    const warnDir = profileDir(outRoot, label, "minimal");
    const opened = await newProfilePage();
    try {
      await captureMinimalWarning(opened.page, warnDir, check, href);
    } finally {
      await opened.context.close();
    }
    check(
      existsSync(path.join(warnDir, "minimal-warning-notifications.png")),
      "minimal warning shot",
    );
  }
  if (tutorial) {
    const tutDir = profileDir(outRoot, label, "default");
    const freshHarnessPage = harness
      ? async (b) => {
          const opened = await harness.newPage(b);
          await freezeContextRandomness(opened.context);
          return opened;
        }
      : async (b) => {
          const context = await b.newContext({
            viewport: { width: 1280, height: 900 },
          });
          await freezeContextRandomness(context);
          const page = await context.newPage();
          return { context, page };
        };
    await captureTutorialPauseFlow(
      browser,
      freshHarnessPage,
      tutDir,
      check,
      href,
      sealLocalOnly,
    );
    for (const step of [
      "tutorial-opt-out-notifications.png",
      "tutorial-pause-only-one.png",
      "tutorial-pause-dismiss-x.png",
      "tutorial-pause-all-queued.png",
      "tutorial-queue-after-reload.png",
      "tutorial-resumed-coach.png",
    ]) {
      const file = path.join(tutDir, step);
      check(existsSync(file), `${step} exists`);
      evidence.push({ build: label, step, sha256: digest(file) });
    }
  }
  evidence.push({
    build: label,
    step: "setup-choices.png",
    sha256: digest(choices),
  });
  if (harness) {
    const hard = harness.log.filter((entry) =>
      ["PAGE-ERROR", "MISSING-ASSET", "LOOPBACK-REQUEST"].includes(entry.kind),
    );
    for (const entry of hard) {
      failures.push(`[${label}] ${entry.kind}: ${entry.detail ?? ""}`);
    }
    for (const fault of harness.failures) {
      failures.push(`[${label}] ${fault}`);
    }
  }
  await context.close();
  return records;
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
