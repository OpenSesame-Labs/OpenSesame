#!/usr/bin/env node
/**
 * #2610 evidence: behavior test main-fail, vault-shell profile PNGs, Playwright consent timing.
 *
 * The before shell is `git show origin/main:apps/pages/src/bindings/shell-ready.ts`.
 * Full-profile timing only: `CONSENT_PROFILES=full`.
 * A missing Playwright main-vs-fix delta warns; `app-root.shell-ready.test.tsx` stays authoritative.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureVaultShellProfiles } from "./capture-vault-shell-profiles.mjs";
import {
  buildDist as buildProfileDist,
  resolveWalks,
} from "./lib/verification-checklist-profiles.mjs";
import { captureConsentActivationTiming } from "./shell-ready-consent-timing.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const pagesRoot = resolve(here, "..");
const repoRoot = resolve(pagesRoot, "../..");
const shellReadyPath = join(pagesRoot, "src/bindings/shell-ready.ts");
const outRoot =
  process.env.PAGES_VERIFY_OUT ??
  join(repoRoot, "artifacts/shell-ready-consent");
const defaultMirror = "/opt/cursor/artifacts/shell-ready-consent";
const mirrorRoot =
  outRoot === join(repoRoot, "artifacts/shell-ready-consent")
    ? defaultMirror
    : null;
const logDir = join(outRoot, "logs");
const BEHAVIOR_SPEC =
  "src/app-root.shell-ready.test.tsx -t withdraws contributed";

for (const dir of [logDir, outRoot, mirrorRoot].filter(Boolean))
  mkdirSync(dir, { recursive: true });

const behaviorTestSource = readFileSync(
  join(pagesRoot, "src/app-root.shell-ready.test.tsx"),
  "utf8",
);
if (!behaviorTestSource.includes("withdraws contributed")) {
  throw new Error(
    "app-root.shell-ready.test.tsx lacks withdraws-contributed case; run collector on verify-formal-stack-main-ee3b-signed",
  );
}

const MAIN_SHELL_SPEC = "origin/main:apps/pages/src/bindings/shell-ready.ts";

function mainShellSource() {
  const result = spawnSync("git", ["show", MAIN_SHELL_SPEC], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const source = result.stdout ?? "";
  if (result.status !== 0 || !source.trim()) {
    throw new Error(
      `git show ${MAIN_SHELL_SPEC} failed (${result.status ?? "no exit"}): ${result.stderr ?? ""}`,
    );
  }
  return source;
}

function vitest(spec, cwd, { expectFail = false }) {
  spawnSync("rm", ["-rf", join(cwd, "node_modules/.vite")], {
    stdio: "ignore",
  });
  const result = spawnSync("npx", ["vitest", "run", ...spec.split(/\s+/)], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CI: "true", VITEST_MAX_WORKERS: "1" },
  });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const skippedAll =
    /Tests\s+0\s+passed.*\d+\s+skipped/.test(text) ||
    (/Tests\s+\d+\s+skipped/.test(text) && !/failed/.test(text) && expectFail);
  if (skippedAll) {
    throw new Error(
      `vitest ran no matching tests for ${spec}; branch may lack app-root.shell-ready withdrawal case`,
    );
  }
  const failedCount = Number(text.match(/Tests\s+(\d+)\s+failed/)?.[1] ?? 0);
  if (expectFail) {
    if (result.status === 0 || failedCount === 0) {
      throw new Error(
        `expected main shell-ready swap to fail tests (${spec}); exit=${result.status} failed=${failedCount}\n${text}`,
      );
    }
  } else if (result.status !== 0) {
    throw new Error(text);
  }
  return text;
}

function withShellSource(source, fn) {
  const saved = readFileSync(shellReadyPath, "utf8");
  writeFileSync(shellReadyPath, source);
  try {
    return fn();
  } finally {
    writeFileSync(shellReadyPath, saved);
  }
}

const fixedSource = readFileSync(shellReadyPath, "utf8");
const mainSource = mainShellSource();
writeFileSync(join(logDir, "main-shell-ready.snapshot.ts"), mainSource);

const mainFailLog = withShellSource(mainSource, () =>
  vitest(BEHAVIOR_SPEC, pagesRoot, { expectFail: true }),
);
writeFileSync(join(logDir, "regression-main-fail.log"), mainFailLog);

writeFileSync(shellReadyPath, fixedSource);
const afterLog = vitest(
  "src/app-root.shell-ready.test.tsx src/bindings/shell-ready-regression.baseline.test.ts src/bindings/shell-ready-formal.replay.test.ts",
  pagesRoot,
  { expectFail: false },
);
writeFileSync(join(logDir, "regression-after-fix.log"), afterLog);

const timingDelayMs = "2500";
process.env.SHELL_READY_CONSENT_ACTIVATION_DELAY_MS = timingDelayMs;
const scriptsDir = join(pagesRoot, "scripts");
const profilesDir = join(pagesRoot, "capability-profiles");
const walks = resolveWalks(profilesDir);

const vaultOut = join(outRoot, "vault-shell-profiles");
const vaultManifest = join(vaultOut, "manifest.json");
if (process.env.SKIP_VAULT_SHELL_CAPTURE === "1" && existsSync(vaultManifest)) {
  console.error(`[evidence] reuse vault-shell profiles at ${vaultManifest}`);
} else {
  await captureVaultShellProfiles({ outDir: vaultOut });
}

const timingByProfile = {};
const consentProfiles = (process.env.CONSENT_PROFILES ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const timingWalks =
  consentProfiles.length > 0
    ? walks.filter((walk) => consentProfiles.includes(walk.name))
    : walks.filter((walk) => walk.name !== "custom");
for (const walk of timingWalks) {
  const timingRoot = join(pagesRoot, "work", "shell-ready-timing");
  const mainDist = join(timingRoot, `${walk.name}-main`);
  const fixDist = join(timingRoot, `${walk.name}-fix`);
  withShellSource(mainSource, () => {
    buildProfileDist({
      appRoot: pagesRoot,
      scriptsDir,
      outDir: mainDist,
      capabilityProfile: walk.capabilityProfile,
    });
  });
  withShellSource(fixedSource, () => {
    buildProfileDist({
      appRoot: pagesRoot,
      scriptsDir,
      outDir: fixDist,
      capabilityProfile: walk.capabilityProfile,
    });
  });
  const beforeDir = join(outRoot, "consent-timing", walk.name, "main");
  const afterDir = join(outRoot, "consent-timing", walk.name, "fix");
  const beforeTiming = await captureConsentActivationTiming({
    distDir: mainDist,
    label: "main",
    outDir: beforeDir,
    walk,
  });
  const afterTiming = await captureConsentActivationTiming({
    distDir: fixDist,
    label: "fix",
    outDir: afterDir,
    walk,
  });
  timingByProfile[walk.name] = { main: beforeTiming, fix: afterTiming };
}

const report = {
  behaviorTest: BEHAVIOR_SPEC,
  playwright: {
    activationDelayMs: Number(timingDelayMs),
    byProfile: timingByProfile,
    expectBeforePreActivationConsent: true,
    expectAfterPreActivationConsent: false,
  },
};
writeFileSync(
  join(outRoot, "evidence-summary.json"),
  JSON.stringify(report, null, 2),
);

let playwrightRepro = false;
for (const [name, row] of Object.entries(timingByProfile)) {
  const beforeShows =
    row.main.pre.consentHeading === true || row.main.pre.consentStub;
  const afterHidden =
    row.fix.pre.consentHeading !== true &&
    !row.fix.pre.consentStub &&
    (row.fix.pre.vaultSkeleton || row.fix.post.consentHeading === true);
  if (beforeShows && afterHidden) playwrightRepro = true;
  if (!beforeShows) {
    console.warn(
      `WARNING: ${name} main build did not show consent pre-activation in Playwright`,
    );
  }
}
if (!playwrightRepro) {
  console.warn(
    "WARNING: Playwright did not show a clear main-vs-fix consent timing delta; vitest App-root behavior test remains authoritative.",
  );
}

if (mirrorRoot && resolve(mirrorRoot) !== resolve(outRoot)) {
  spawnSync("rm", ["-rf", mirrorRoot], { stdio: "inherit" });
  const copied = spawnSync("cp", ["-a", outRoot, mirrorRoot], {
    stdio: "inherit",
  });
  if (copied.status !== 0) {
    throw new Error(`evidence mirror failed: ${copied.status}`);
  }
}
console.log(`Evidence complete: ${outRoot}`);
