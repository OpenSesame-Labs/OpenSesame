#!/usr/bin/env node
/**
 * #2610 evidence: behavior test main-fail, vault-shell profile PNGs, Playwright consent timing.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureVaultShellProfiles } from "./capture-vault-shell-profiles.mjs";
import { captureConsentActivationTiming } from "./shell-ready-consent-timing.mjs";
import {
  buildDist as buildProfileDist,
  resolveWalks,
} from "./lib/verification-checklist-profiles.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const pagesRoot = resolve(here, "..");
const repoRoot = resolve(pagesRoot, "../..");
const shellReadyPath = join(pagesRoot, "src/bindings/shell-ready.ts");
const outRoot =
  process.env.PAGES_VERIFY_OUT ??
  join(repoRoot, "artifacts/shell-ready-consent");
const mirrorRoot = "/opt/cursor/artifacts/shell-ready-consent";
const logDir = join(outRoot, "logs");
const BEHAVIOR_SPEC =
  "src/app-root.shell-ready.test.tsx -t withdraws contributed";

for (const dir of [logDir, outRoot, mirrorRoot]) mkdirSync(dir, { recursive: true });

function mainShellSource() {
  const out = spawnSync(
    "git",
    ["show", "origin/main:apps/pages/src/bindings/shell-ready.ts"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (out.status !== 0 || !out.stdout.trim()) throw new Error("main shell-ready");
  return out.stdout;
}

function vitest(spec, cwd, { expectFail = false }) {
  const result = spawnSync("npx", ["vitest", "run", ...spec.split(/\s+/)], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CI: "true" },
  });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (expectFail ? result.status === 0 : result.status !== 0) {
    throw new Error(expectFail ? `expected failure: ${spec}` : text);
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

function buildDist(shellSource, copyTo, extraEnv = {}) {
  withShellSource(shellSource, () => {
    const built = spawnSync("npm", ["run", "build", "-w", "@opensesame/pages"], {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        VITE_BASE: "/OpenSesame/",
        VITE_VERIFY_ACTIVATION_DELAY_MS: extraEnv.delay ?? "",
      },
    });
    if (built.status !== 0) process.exit(built.status ?? 1);
    if (copyTo) {
      spawnSync("rm", ["-rf", copyTo], { stdio: "inherit" });
      spawnSync("cp", ["-a", join(pagesRoot, "dist"), copyTo], { stdio: "inherit" });
    }
  });
}

const fixedSource = readFileSync(shellReadyPath, "utf8");
const mainSource = mainShellSource();
writeFileSync(join(logDir, "main-shell-ready.snapshot.ts"), mainSource);

const mainFailLog = withShellSource(mainSource, () =>
  vitest(BEHAVIOR_SPEC, pagesRoot, { expectFail: true }),
);
writeFileSync(join(logDir, "regression-main-fail.log"), mainFailLog);

const afterLog = vitest(
  "src/app-root.shell-ready.test.tsx src/bindings/shell-ready-regression.baseline.test.ts src/bindings/shell-ready-formal.replay.test.ts",
  pagesRoot,
  { expectFail: false },
);
writeFileSync(join(logDir, "regression-after-fix.log"), afterLog);

const delay = "2500";
const viteEnv = { VITE_VERIFY_ACTIVATION_DELAY_MS: delay };
const scriptsDir = join(pagesRoot, "scripts");
const profilesDir = join(pagesRoot, "capability-profiles");
const walks = resolveWalks(profilesDir);

const vaultOut = join(outRoot, "vault-shell-profiles");
await captureVaultShellProfiles({ outDir: vaultOut });

const timingByProfile = {};
for (const walk of walks) {
  const mainDist = join(pagesRoot, `dist-timing-${walk.name}-main`);
  const fixDist = join(pagesRoot, `dist-timing-${walk.name}-fix`);
  withShellSource(mainSource, () => {
    buildProfileDist({
      appRoot: pagesRoot,
      scriptsDir,
      outDir: mainDist,
      capabilityProfile: walk.capabilityProfile,
      viteEnv,
    });
  });
  withShellSource(fixedSource, () => {
    buildProfileDist({
      appRoot: pagesRoot,
      scriptsDir,
      outDir: fixDist,
      capabilityProfile: walk.capabilityProfile,
      viteEnv,
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
    activationDelayMs: Number(delay),
    byProfile: timingByProfile,
    expectBeforePreActivationConsent: true,
    expectAfterPreActivationConsent: false,
  },
};
writeFileSync(join(outRoot, "evidence-summary.json"), JSON.stringify(report, null, 2));

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

spawnSync("rm", ["-rf", mirrorRoot], { stdio: "inherit" });
spawnSync("cp", ["-a", outRoot, mirrorRoot], { stdio: "inherit" });
console.log(`Evidence complete: ${outRoot}`);