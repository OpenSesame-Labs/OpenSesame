import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { freezeContextRandomness } from "./setup-pause-freeze.mjs";
import {
  assertOnSetup,
  assertRoads,
  captureMinimalWarning,
  captureProfilePicker,
  captureTutorialPauseFlow,
  openSetupChoices,
  profileDir,
  shotFrame,
} from "./setup-pause-walk.mjs";
import { createHarness } from "./static-origin-harness.mjs";

const PROFILES = ["minimal", "default", "custom", "full"];

const tutorialSteps = [
  "tutorial-opt-out-notifications.png",
  "tutorial-pause-only-one.png",
  "tutorial-pause-dismiss-x.png",
  "tutorial-pause-all-queued.png",
  "tutorial-queue-after-reload.png",
  "tutorial-resumed-coach.png",
];

export async function openBuildBrowser(
  browser,
  { label, dist, devUrl, href, BASE, outRoot },
) {
  if (!devUrl && !existsSync(path.join(dist, "index.html"))) {
    throw new Error(`no dist at ${dist} for build ${label}`);
  }
  // Dev URL skips the static-origin router. Keep the same hard-fault log
  // so the branch phase still surfaces page, asset, and loopback faults.
  const harness = devUrl
    ? createDevUrlHarness(devUrl)
    : createHarness({
        dist,
        origin: "https://opensesame-labs.github.io",
        base: BASE,
        out: outRoot,
      });
  const opened = await harness.newPage(browser);
  const { context, page } = opened;
  try {
    await freezeContextRandomness(context);
    console.log(`build ${label}`);
    await openSetupChoices(page, href);
    const shared = path.join(outRoot, label);
    mkdirSync(shared, { recursive: true });
    const choices = path.join(shared, "setup-choices.png");
    await shotFrame(page, choices);
    return { context, page, harness, choices };
  } catch (error) {
    // A navigation timeout must not leak the context for the rest of the run.
    await context.close().catch(() => {});
    throw error;
  }
}

function newProfilePageFactory(harness) {
  if (harness) {
    return async (b) => {
      const opened = await harness.newPage(b);
      await freezeContextRandomness(opened.context);
      return opened;
    };
  }
  return async (b) => {
    const context = await b.newContext({
      viewport: { width: 1280, height: 900 },
    });
    await freezeContextRandomness(context);
    const page = await context.newPage();
    return { context, page };
  };
}

export async function captureProfileRecords(
  browser,
  { harness, label, href, outRoot, check, digest },
) {
  const newProfilePage = newProfilePageFactory(harness);
  const records = [];
  const profileMarkerKeys = [];
  const appliedHashes = [];
  const featuresHashes = [];
  for (const id of PROFILES) {
    const opened = await newProfilePage(browser);
    try {
      const applied = await captureProfilePicker(
        opened.page,
        href,
        profileDir(outRoot, label, id),
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
  return records;
}

export async function captureAdvancedMinimalWarning(
  browser,
  { harness, expectAdvanced, label, href, outRoot, check },
) {
  if (!expectAdvanced) return;
  const newProfilePage = newProfilePageFactory(harness);
  const warnDir = profileDir(outRoot, label, "minimal");
  const opened = await newProfilePage(browser);
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

export async function captureTutorialPauseEvidence(
  browser,
  { harness, label, href, outRoot, check, digest },
  evidence,
) {
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
  // Full-page tray and coach shots may share pixels across profiles when
  // the pause UI is the same. That match is not a pause failure. Profile
  // identity stays on vault markers and applied/features hashes.
  // Each profile still has to pass the pause behavior checks in the walk,
  // and its own step shots have to differ.
}

const HARNESS_HARD_FAULTS = ["PAGE-ERROR", "MISSING-ASSET", "LOOPBACK-REQUEST"];

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;

function isAssetPath(pathname) {
  const rel = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  return rel.length > 0 && /\.[a-z0-9]+$/i.test(rel);
}

function isOwnDevServer(url, dev) {
  if (url.origin === dev.origin) return true;
  return (
    LOOPBACK_HOST.test(url.hostname) &&
    LOOPBACK_HOST.test(dev.hostname) &&
    url.port === dev.port
  );
}

function watchDevPageFaults(page, record, dev) {
  page.on("pageerror", (error) => {
    record(
      "PAGE-ERROR",
      String(error?.stack || error?.message || error || "unknown").slice(
        0,
        800,
      ),
    );
  });
  page.on("response", (response) => {
    if (response.status() !== 404) return;
    let url;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (!isAssetPath(url.pathname)) return;
    record("MISSING-ASSET", url.pathname);
  });
  page.on("request", (request) => {
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (url.protocol === "blob:" || url.protocol === "data:") return;
    if (isOwnDevServer(url, dev)) return;
    if (!LOOPBACK_HOST.test(url.hostname)) return;
    record("LOOPBACK-REQUEST", `${request.method()} ${request.url()}`);
  });
}

function createDevUrlHarness(devUrl) {
  const log = [];
  const failures = [];
  const record = (kind, detail) => {
    log.push({ step: "dev", kind, detail });
  };
  const dev = new URL(devUrl);
  return {
    log,
    failures,
    async newPage(browser) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();
      watchDevPageFaults(page, record, dev);
      return { context, page };
    },
  };
}

export function collectHarnessFailures(harness, label, failures) {
  if (!harness?.log) {
    failures.push(
      `[${label}] PAGE-ERROR, MISSING-ASSET, and LOOPBACK-REQUEST were not observed`,
    );
    return;
  }
  const hard = harness.log.filter((entry) =>
    HARNESS_HARD_FAULTS.includes(entry.kind),
  );
  for (const entry of hard) {
    failures.push(`[${label}] ${entry.kind}: ${entry.detail ?? ""}`);
  }
  for (const fault of harness.failures ?? []) {
    failures.push(`[${label}] ${fault}`);
  }
}

export async function runBuildPhase(
  browser,
  options,
  { check, digest, evidence, failures },
) {
  const { label, dist, expectAdvanced, tutorial, devUrl, href, BASE, outRoot } =
    options;
  const { context, page, harness, choices } = await openBuildBrowser(browser, {
    label,
    dist,
    devUrl,
    href,
    BASE,
    outRoot,
  });
  let records = [];
  try {
    await assertOnSetup(page, check);
    await assertRoads(page, check, expectAdvanced);
    check(existsSync(choices), `${label} setup-choices.png written`);
    records = await captureProfileRecords(browser, {
      harness,
      devUrl,
      label,
      href,
      outRoot,
      check,
      digest,
    });
    await captureAdvancedMinimalWarning(browser, {
      harness,
      devUrl,
      expectAdvanced,
      label,
      href,
      outRoot,
      check,
    });
    if (tutorial) {
      await captureTutorialPauseEvidence(
        browser,
        { harness, devUrl, label, href, outRoot, check, digest },
        evidence,
      );
    }
    evidence.push({
      build: label,
      step: "setup-choices.png",
      sha256: digest(choices),
    });
  } finally {
    // Page errors and loopback faults matter even when a step timed out, and
    // the context has to go either way; neither may wait for the throw.
    collectHarnessFailures(harness, label, failures);
    await context.close().catch(() => {});
  }
  return records;
}
