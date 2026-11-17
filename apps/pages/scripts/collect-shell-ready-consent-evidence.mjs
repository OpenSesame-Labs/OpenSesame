#!/usr/bin/env node
/**
 * Collect #2610 evidence: main-fail logs, profile PNGs, pixel diff, Playwright trace.
 * Outputs to PAGES_VERIFY_OUT or repo artifacts/shell-ready-consent (mirrored to /opt/cursor/artifacts).
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalIamRig } from "./lib/local-iam-rig.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const pagesRoot = resolve(here, "..");
const repoRoot = resolve(pagesRoot, "../..");
const shellReadyPath = join(pagesRoot, "src/bindings/shell-ready.ts");
const outRoot =
  process.env.PAGES_VERIFY_OUT ??
  join(repoRoot, "artifacts/shell-ready-consent");
const logDir = join(outRoot, "logs");
const profilesBefore = join(outRoot, "profiles-before");
const profilesAfter = join(outRoot, "profiles-after");
const mirrorRoot = "/opt/cursor/artifacts/shell-ready-consent";

for (const dir of [logDir, profilesBefore, profilesAfter, mirrorRoot]) {
  mkdirSync(dir, { recursive: true });
}

function mainShellSource() {
  const out = spawnSync(
    "git",
    ["show", "origin/main:apps/pages/src/bindings/shell-ready.ts"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (out.status !== 0 || !out.stdout.trim()) throw new Error("main shell-ready");
  return out.stdout;
}

function vitest(specs, cwd, expectFail) {
  const result = spawnSync("npx", ["vitest", "run", ...specs], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CI: "true" },
  });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (expectFail ? result.status === 0 : result.status !== 0) {
    throw new Error(
      expectFail
        ? `expected vitest failure for ${specs}`
        : `vitest failed: ${specs}`,
    );
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

function buildDist(shellSource, copyTo) {
  withShellSource(shellSource, () => {
    const built = spawnSync("npm", ["run", "build", "-w", "@opensesame/pages"], {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, VITE_BASE: "/OpenSesame/" },
    });
    if (built.status !== 0) process.exit(built.status ?? 1);
    if (copyTo) {
      spawnSync("rm", ["-rf", copyTo], { stdio: "inherit" });
      spawnSync("cp", ["-a", join(pagesRoot, "dist"), copyTo], {
        stdio: "inherit",
      });
    }
  });
}

function profileProof(outDir, distDir) {
  const result = spawnSync(
    "node",
    ["scripts/ci/pwa-install-profile-proof.mjs"],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        VERIFY_SKIP_BUILD: "1",
        PWA_PROFILE_PROOF_OUT: outDir,
        PAGES_VERIFY_DIST: distDir,
      },
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pixelDiffReport(beforeDir, afterDir, reportPath, bundlePaths) {
  const names = [
    "minimal-local.png",
    "default.png",
    "custom.png",
    "full.png",
  ];
  const lines = [
    "# Install-profile composite PNGs (front-door walk)",
    ...names.map((name) => {
      const bHash = sha256File(join(beforeDir, name));
      const aHash = sha256File(join(afterDir, name));
      return `${name}: byte_identical=${bHash === aHash}`;
    }),
    "",
    "# Application main chunk (shell-ready gate)",
    `main-before: sha256=${sha256File(bundlePaths.before)} (${bundlePaths.before})`,
    `main-after: sha256=${sha256File(bundlePaths.after)} (${bundlePaths.after})`,
    `bundle_byte_identical=${sha256File(bundlePaths.before) === sha256File(bundlePaths.after)}`,
  ];
  writeFileSync(reportPath, `${lines.join("\n")}\n`);
  console.log(`wrote ${reportPath}`);
}

function findMainChunk(distDir) {
  const assets = join(distDir, "assets");
  const main = readdirSync(assets).find((f) => /^main-[\w-]+\.js$/.test(f));
  if (!main) throw new Error(`no main chunk in ${distDir}`);
  return join(assets, main);
}

async function consentTrace(distDir, label) {
  const origin = "https://opensesame-labs.github.io";
  const base = "/OpenSesame/";
  const rp = "https://rp.example.test";
  const issuerUrl = `${origin}${base}identity/authorize`;
  const shotDir = join(outRoot, `playwright-${label}`);
  mkdirSync(shotDir, { recursive: true });
  const harness = createHarness({ dist: distDir, origin, base, out: shotDir });
  const captures = { path: () => shotDir };
  const { browser, seedJourney, openConsent } = await createLocalIamRig({
    harness,
    origin,
    rp,
    issuerUrl,
    captures,
  });
  const context = browser.contexts()[0];
  if (!context) throw new Error("rig did not create a browser context");
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
  try {
    const { page, context: rpContext, credentials } = await seedJourney(false);
    const { popup } = await openConsent(page, rpContext, credentials, 1280);
    await popup.screenshot({ path: join(shotDir, "consent-popup-frame.png") });
    const vaultSkeleton = await popup.locator(".vault-skeleton").count();
    const bodyText = await popup.locator("body").innerText();
    writeFileSync(
      join(shotDir, "consent-timing.json"),
      JSON.stringify(
        { vaultSkeleton, bodySnippet: bodyText.slice(0, 400) },
        null,
        2,
      ),
    );
  } finally {
    await context.tracing.stop({ path: join(shotDir, "trace.zip") });
    await browser.close();
  }
  copyFileSync(
    join(shotDir, "trace.zip"),
    join(outRoot, `${label}-consent-trace.zip`),
  );
  console.log(`wrote playwright ${label} trace`);
}

const fixedSource = readFileSync(shellReadyPath, "utf8");
const mainSource = mainShellSource();

writeFileSync(join(logDir, "main-shell-ready.snapshot.ts"), mainSource);

const mainFailLog = withShellSource(mainSource, () =>
  vitest(["src/bindings/shell-ready-fix-required.test.ts"], pagesRoot, true),
);
writeFileSync(join(logDir, "regression-main-fail.log"), mainFailLog);

const afterLog = vitest(
  [
    "src/bindings/shell-ready-regression.baseline.test.ts",
    "src/bindings/shell-ready-formal.replay.test.ts",
    "src/app-root.shell-ready.test.tsx",
  ],
  pagesRoot,
  false,
);
writeFileSync(join(logDir, "regression-after-fix.log"), afterLog);

const baselineDist = join(pagesRoot, "dist-shell-before");
const fixedDist = join(pagesRoot, "dist");
buildDist(mainSource, baselineDist);
buildDist(fixedSource, fixedDist);

profileProof(profilesBefore, baselineDist);
profileProof(profilesAfter, fixedDist);
pixelDiffReport(profilesBefore, profilesAfter, join(outRoot, "profile-pixel-diff.txt"), {
  before: findMainChunk(baselineDist),
  after: findMainChunk(fixedDist),
});

await consentTrace(baselineDist, "before");
await consentTrace(fixedDist, "after");

function mirrorTree(src, dest) {
  spawnSync("rm", ["-rf", dest], { stdio: "inherit" });
  spawnSync("cp", ["-a", src, dest], { stdio: "inherit" });
}
mirrorTree(outRoot, mirrorRoot);
console.log(`Evidence complete: ${outRoot} (mirrored to ${mirrorRoot})`);