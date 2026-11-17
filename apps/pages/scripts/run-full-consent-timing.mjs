#!/usr/bin/env node
/** One-off: full-profile consent timing only (main vs fix shell-ready). */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDist,
  resolveWalks,
} from "./lib/verification-checklist-profiles.mjs";
import { captureConsentActivationTiming } from "./shell-ready-consent-timing.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const pagesRoot = resolve(here, "..");
const repoRoot = resolve(pagesRoot, "../..");
const shellReadyPath = join(pagesRoot, "src/bindings/shell-ready.ts");
const outRoot =
  process.env.PAGES_VERIFY_OUT ?? "/opt/cursor/artifacts/shell-ready-consent";
const profilesDir = join(pagesRoot, "capability-profiles");
const walk = resolveWalks(profilesDir).find((w) => w.name === "full");
if (!walk) throw new Error("full profile walk missing");

function mainShellSource() {
  const out = spawnSync(
    "git",
    ["show", "origin/main:apps/pages/src/bindings/shell-ready.ts"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (out.status !== 0) throw new Error("main shell-ready");
  return out.stdout;
}

function withShell(source, fn) {
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
const viteEnv = { VITE_VERIFY_ACTIVATION_DELAY_MS: "2500" };
const scriptsDir = join(pagesRoot, "scripts");
const mainDist = join(pagesRoot, "dist-timing-full-main");
const fixDist = join(pagesRoot, "dist-timing-full-fix");

withShell(mainSource, () =>
  buildDist({
    appRoot: pagesRoot,
    scriptsDir,
    outDir: mainDist,
    capabilityProfile: walk.capabilityProfile,
    viteEnv,
  }),
);
withShell(fixedSource, () =>
  buildDist({
    appRoot: pagesRoot,
    scriptsDir,
    outDir: fixDist,
    capabilityProfile: walk.capabilityProfile,
    viteEnv,
  }),
);

const mainDir = join(outRoot, "consent-timing", "full", "main");
const fixDir = join(outRoot, "consent-timing", "full", "fix");
mkdirSync(mainDir, { recursive: true });
mkdirSync(fixDir, { recursive: true });

const mainTiming = await captureConsentActivationTiming({
  distDir: mainDist,
  label: "main",
  outDir: mainDir,
  walk,
});
const fixTiming = await captureConsentActivationTiming({
  distDir: fixDist,
  label: "fix",
  outDir: fixDir,
  walk,
});

writeFileSync(
  join(outRoot, "consent-timing-full-summary.json"),
  JSON.stringify({ main: mainTiming, fix: fixTiming }, null, 2),
);
console.log("full consent timing complete");
