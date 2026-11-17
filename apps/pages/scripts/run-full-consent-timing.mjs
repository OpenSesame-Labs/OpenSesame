#!/usr/bin/env node
/** One-off: full-profile consent timing only (main vs fix shell-ready). */

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
const shellReadyPath = join(pagesRoot, "src/bindings/shell-ready.ts");
const outRoot =
  process.env.PAGES_VERIFY_OUT ?? "/opt/cursor/artifacts/shell-ready-consent";
const profilesDir = join(pagesRoot, "capability-profiles");
const walk = resolveWalks(profilesDir).find((w) => w.name === "full");
if (!walk) throw new Error("full profile walk missing");

function mainShellSource() {
  const source = readFileSync(
    join(pagesRoot, "scripts/fixtures/shell-ready-pre-fix.ts"),
    "utf8",
  );
  if (!source.trim()) throw new Error("pre-fix shell-ready fixture is empty");
  return source;
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
const timingRoot = join(pagesRoot, "work", "shell-ready-timing");
const mainDist = join(timingRoot, "full-main");
const fixDist = join(timingRoot, "full-fix");

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
