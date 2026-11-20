#!/usr/bin/env node
/**
 * Mobile first-vault / setup tutorial evidence per install profile.
 *
 * Builds each install profile walk (`minimal-local`, `default`, `custom`,
 * `full` — the same `resolveWalks` set as the checklist), then walks the
 * mobile first-vault tutorial on each build at a phone viewport
 * (390×844, touch) with `runFirstVaultPass`, saving a PNG per coach beat.
 * The gate guide is authored for the Default road, so the walk takes that
 * road on every build; what changes per profile is the build itself —
 * minimal-local has no account item type, so its walk turns on the Account
 * pack where the stock builds go straight to the shell guide.
 *
 *   npm run capture:mobile-tutorial-profiles -w @opensesame/pages
 *
 * Output lands in
 * `/cursor/stores/bot/sweep/council/pr-2773-shots-<head8>/<phase>/<profile>/`
 * where `<head8>` is the built tree's `git rev-parse --short=8 HEAD` — the
 * merge commit for the default `after` phase, main's head for `before`.
 *
 * Two phases, two runs:
 *
 *   after   — the current tree (default). Run after the merge commits.
 *   before  — a pristine `origin/main` checkout:
 *               node scripts/capture-mobile-tutorial-profile-evidence.mjs \
 *                 --phase before --tree /path/to/main-checkout
 *             `--tree` needs its own `npm ci`: the root `node_modules`
 *             symlinks `@opensesame/*` at this repo's packages, which would
 *             leak the merged sources into a main build.
 *
 * `VERIFY_SKIP_BUILD=1` reuses `dist-profiles/mobile-tutorial-<build>/`.
 * `MOBILE_TUTORIAL_OUT` overrides the output root.
 *
 * The four profiles must not produce byte-identical shot sets: a profile
 * build that did not take (four identical digests) fails the run.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChromium } from "./duress/find-chromium.mjs";
import {
  createHarness,
  serveLoopbackDist,
} from "./lib/static-origin-harness.mjs";
import { runFirstVaultPass } from "./lib/tutorial-first-vault.mjs";
import { createTutorialPageFactory } from "./lib/tutorial-page.mjs";
import {
  buildDist,
  resolveWalks,
} from "./lib/verification-checklist-profiles.mjs";
import { BASE } from "./lib/verification-checklist-shot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultPagesRoot = path.join(here, "..");

function argValue(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const phase =
  argValue("--phase") ?? process.env.MOBILE_TUTORIAL_PHASE ?? "after";
const tree = path.resolve(
  argValue("--tree") ??
    process.env.MOBILE_TUTORIAL_TREE ??
    path.resolve(defaultPagesRoot, "../.."),
);
const pagesRoot =
  tree === path.resolve(defaultPagesRoot, "../..")
    ? defaultPagesRoot
    : path.join(tree, "apps", "pages");
const scriptsDir = path.join(pagesRoot, "scripts");
const profilesDir = path.join(pagesRoot, "capability-profiles");

const head = execFileSync(
  "git",
  ["-C", tree, "rev-parse", "--short=8", "HEAD"],
  {
    encoding: "utf8",
  },
).trim();
const outRoot =
  process.env.MOBILE_TUTORIAL_OUT ??
  path.join("/cursor/stores/bot/sweep/council", `pr-2773-shots-${head}`);
const outDir = path.join(outRoot, phase);

const discovery = findChromium();
if (!discovery.path) throw new Error("no chromium for mobile tutorial capture");
process.env.PLAYWRIGHT_CHROMIUM = discovery.path;
const { chromium } = await import("playwright");

function pngFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...pngFiles(full));
    else if (entry.endsWith(".png")) out.push(full);
  }
  return out.sort();
}

function digestFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function profileDigest(dir) {
  const lines = pngFiles(dir).map(
    (file) => `${digestFile(file)}  ${path.relative(dir, file)}`,
  );
  return {
    count: lines.length,
    composite: createHash("sha256").update(lines.join("\n")).digest("hex"),
    files: lines,
  };
}

const browser = await chromium.launch({
  executablePath: discovery.path,
  headless: true,
});
const walks = resolveWalks(profilesDir);
const built = new Set();
const manifests = [];
const failures = [];

for (const walk of walks) {
  console.log(
    `\n[mobile-tutorial] ${phase} ${walk.name} (${walk.note || "fixture build"})`,
  );
  const dist = path.join(
    pagesRoot,
    "dist-profiles",
    `mobile-tutorial-${walk.buildKey}`,
  );
  // default and custom share the stock build; a buildKey already built in
  // this run is reused rather than rebuilt.
  if (built.has(walk.buildKey)) process.env.VERIFY_SKIP_BUILD = "1";
  buildDist({
    appRoot: pagesRoot,
    scriptsDir,
    outDir: dist,
    capabilityProfile: walk.capabilityProfile,
  });
  built.add(walk.buildKey);
  delete process.env.TUTORIALS_KEYBOARD_VIEWPORT;
  delete process.env.TUTORIALS_RECOVERY;
  delete process.env.TUTORIALS_PEPPER_BACK;
  delete process.env.TUTORIALS_GENERATION_FAILURE;

  const server = await serveLoopbackDist({ dist, base: BASE });
  const profileOut = path.join(outDir, walk.name);
  mkdirSync(profileOut, { recursive: true });
  const harness = createHarness({
    dist,
    origin: server.origin,
    base: BASE,
    out: profileOut,
  });
  const localFailures = [];
  const check = (ok, what) => {
    if (!ok) localFailures.push(what);
  };
  try {
    const newPage = createTutorialPageFactory({ browser, devUrl: "", harness });
    await runFirstVaultPass({
      newPage,
      width: 390,
      origin: server.origin,
      base: BASE,
      check,
      phone: true,
      out: profileOut,
      keepShots: true,
    });
  } finally {
    await server.close();
  }
  const digest = profileDigest(profileOut);
  manifests.push({
    phase,
    profile: walk.name,
    buildKey: walk.buildKey,
    dir: profileOut,
    pngCount: digest.count,
    files: digest.files,
    sha256: digest.composite,
    walkFailures: localFailures,
  });
  failures.push(...localFailures.map((what) => `${walk.name}: ${what}`));
  console.log(
    `[mobile-tutorial] ${walk.name}: ${digest.count} PNGs, composite ${digest.composite.slice(0, 16)}…`,
  );
}

await browser.close();

mkdirSync(outDir, { recursive: true });
const composites = manifests.map((manifest) => manifest.sha256);
const unique = new Set(composites);
const report = [
  `phase: ${phase}`,
  `tree: ${tree} (${head})`,
  `profiles: ${walks.map((walk) => walk.name).join(", ")}`,
  `unique composite digests: ${unique.size} of ${manifests.length}`,
  "",
  ...manifests.flatMap((manifest) => [
    `## ${manifest.profile} → ${manifest.sha256} (${manifest.pngCount} PNGs)`,
    ...manifest.files,
    "",
  ]),
];
writeFileSync(path.join(outDir, "cross-profile-hashes.txt"), report.join("\n"));
writeFileSync(
  path.join(outDir, "manifest.json"),
  JSON.stringify({ phase, tree, head, manifests }, null, 2),
);

if (unique.size === manifests.length && manifests.length > 1) {
  console.log(
    `\n[mobile-tutorial] all ${manifests.length} profile shot sets are distinct`,
  );
} else if (unique.size > 1) {
  console.log(
    `\n[mobile-tutorial] ${unique.size} distinct shot sets of ${manifests.length} (default and custom share the stock build)`,
  );
} else {
  failures.push(
    "all four profile shot sets are byte-identical — the profile build did not take",
  );
}

if (failures.length > 0) {
  console.error(`\n[mobile-tutorial] FAILURES:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`[mobile-tutorial] evidence → ${outDir}`);
