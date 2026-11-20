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
  const profileMarkerKeys = [];
  const appliedHashes = [];
  const featuresHashes = [];
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
      check(
        existsSync(applied.picker),
        `${label}/${id} setup-profile-picker.png`,
      );
      profileMarkerKeys.push(applied.markerKey);
      const appliedHash = digest(applied.file);
      const featuresHash = digest(applied.features);
      appliedHashes.push(appliedHash);
      featuresHashes.push(featuresHash);
      records.push({
        build: label,
        profile: id,
        setupProfileApplied: appliedHash,
        setupProfileFeatures: featuresHash,
        setupProfilePicker: digest(applied.picker),
        vaultMarkers: applied.markers,
        vaultMarkerKey: applied.markerKey,
      });
    } finally {
      await opened.context.close();
    }
  }
  check(
    new Set(profileMarkerKeys).size === profileMarkerKeys.length,
    `each profile leaves distinct vault DOM markers: ${profileMarkerKeys.join(" · ")}`,
  );
  check(
    new Set(appliedHashes).size === appliedHashes.length,
    `each profile vault screenshot differs (${appliedHashes.length} profiles)`,
  );
  check(
    new Set(featuresHashes).size === featuresHashes.length,
    `each profile Features screenshot differs (${featuresHashes.length} profiles)`,
  );
  for (const id of PROFILES) {
    const applied = path.join(outRoot, label, id, "setup-profile-applied.png");
    check(
      existsSync(applied),
      `${label}/${id} setup-profile-applied.png on disk`,
    );
  }
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
    const tutorialSteps = [
      "tutorial-opt-out-notifications.png",
      "tutorial-pause-only-one.png",
      "tutorial-pause-dismiss-x.png",
      "tutorial-pause-all-queued.png",
      "tutorial-queue-after-reload.png",
      "tutorial-resumed-coach.png",
    ];
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
    for (const id of PROFILES) {
      const tutDir = profileDir(outRoot, label, id);
      console.log(`  tutorial pause flow profile ${id}`);
      await captureTutorialPauseFlow(
        browser,
        freshHarnessPage,
        tutDir,
        check,
        href,
        sealLocalOnly,
        id,
      );
      const shotHashes = [];
      for (const step of tutorialSteps) {
        const file = path.join(tutDir, step);
        check(existsSync(file), `${label}/${id}/${step} exists`);
        const hash = digest(file);
        shotHashes.push(hash);
        evidence.push({
          build: label,
          profile: id,
          step,
          sha256: hash,
        });
      }
      check(
        new Set(shotHashes).size === shotHashes.length,
        `${label}/${id} tutorial shots differ by hash (${shotHashes.length})`,
      );
      const onlyOne = path.join(tutDir, "tutorial-pause-only-one.png");
      const dismissX = path.join(tutDir, "tutorial-pause-dismiss-x.png");
      check(
        digest(onlyOne) !== digest(dismissX),
        `${label}/${id} pause only-one vs dismiss-x screenshots differ`,
      );
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
