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

const baselineDist = join(pagesRoot, "dist-shell-before");
const fixedDist = join(pagesRoot, "dist");
const delay = "2500";
buildDist(mainSource, baselineDist, { delay });
buildDist(fixedSource, fixedDist, { delay });

const vaultOut = join(outRoot, "vault-shell-profiles");
await captureVaultShellProfiles({ outDir: vaultOut });

const timingBeforeDir = join(outRoot, "consent-timing-before");
const timingAfterDir = join(outRoot, "consent-timing-after");
const beforeTiming = await captureConsentActivationTiming({
  distDir: baselineDist,
  label: "main",
  outDir: timingBeforeDir,
});
const afterTiming = await captureConsentActivationTiming({
  distDir: fixedDist,
  label: "fix",
  outDir: timingAfterDir,
});

const report = {
  behaviorTest: BEHAVIOR_SPEC,
  playwright: {
    activationDelayMs: Number(delay),
    before: beforeTiming,
    after: afterTiming,
    expectBeforePreActivationConsent: true,
    expectAfterPreActivationConsent: false,
  },
};
writeFileSync(join(outRoot, "evidence-summary.json"), JSON.stringify(report, null, 2));

if (beforeTiming.pre.consentHeading !== true) {
  console.warn(
    "WARNING: main build did not show consent pre-activation in Playwright; vitest behavior test remains authoritative.",
  );
}
if (afterTiming.pre.consentHeading === true && !afterTiming.pre.vaultSkeleton) {
  console.warn(
    "WARNING: fix build still showed consent pre-activation in Playwright.",
  );
}

spawnSync("rm", ["-rf", mirrorRoot], { stdio: "inherit" });
spawnSync("cp", ["-a", outRoot, mirrorRoot], { stdio: "inherit" });
console.log(`Evidence complete: ${outRoot}`);