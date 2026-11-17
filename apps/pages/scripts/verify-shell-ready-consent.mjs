#!/usr/bin/env node
/**
 * Shell-ready consent gating evidence for #2607.
 *
 *   npm run verify:shell-ready-consent -w @opensesame/pages
 *
 * The before shell is `git show origin/main:apps/pages/src/bindings/shell-ready.ts`,
 * swapped over the reviewed shell for that build. There is no checked-in pre-fix fixture.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
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
mkdirSync(logDir, { recursive: true });

function runVitest(relativeSpecs, logName) {
  const args = ["vitest", "run", ...relativeSpecs];
  const result = spawnSync("npx", args, {
    cwd: pagesRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  writeFileSync(
    join(logDir, logName),
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  if (result.status !== 0) throw new Error(`vitest failed: ${relativeSpecs}`);
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

function buildDist(shellSource, distCopyTarget) {
  const saved = readFileSync(shellReadyPath, "utf8");
  writeFileSync(shellReadyPath, shellSource);
  try {
    const built = spawnSync(
      "npm",
      ["run", "build", "-w", "@opensesame/pages"],
      {
        cwd: repoRoot,
        stdio: "inherit",
        env: {
          ...process.env,
          VITE_BASE: "/OpenSesame/",
        },
      },
    );
    if (built.status !== 0) {
      throw new Error(`pages build failed: ${built.status ?? 1}`);
    }
    if (distCopyTarget) {
      spawnSync("rm", ["-rf", distCopyTarget], {
        cwd: pagesRoot,
        stdio: "inherit",
      });
      spawnSync("cp", ["-a", "dist", distCopyTarget], {
        cwd: pagesRoot,
        stdio: "inherit",
      });
    }
  } finally {
    writeFileSync(shellReadyPath, saved);
  }
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
        PWA_PROFILE_PROOF_NAME: "full",
        PWA_PROFILE_PROOF_DIST: distDir,
      },
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function playwrightConsent(distDir, label, expectEarlyConsent) {
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
  try {
    const { page, context, credentials } = await seedJourney(false);
    let during = { consentHeading: false, vaultSkeleton: false };
    const { popup } = await openConsent(
      page,
      context,
      credentials,
      1280,
      false,
      async (consentPopup) => {
        const started = Date.now();
        while (Date.now() - started < 800) {
          during = await consentPopup.evaluate(() => ({
            consentHeading: [...document.querySelectorAll("h1,h2")].some(
              (node) =>
                /Sign in to|Authorize agent/.test(node.textContent ?? ""),
            ),
            vaultSkeleton: Boolean(document.querySelector(".vault-skeleton")),
          }));
          if (during.consentHeading || during.vaultSkeleton) return;
          await consentPopup.waitForTimeout(50);
        }
      },
    );
    await popup.screenshot({
      path: join(shotDir, "consent-popup.png"),
    });
    if (expectEarlyConsent) {
      expect(during.consentHeading).toBe(true);
    } else {
      expect(during.consentHeading).toBe(false);
      expect(during.vaultSkeleton).toBe(true);
    }
  } finally {
    await browser.close();
  }
  console.log(`PASS playwright consent timing (${label})`);
}

runVitest(
  [
    "src/bindings/shell-ready-regression.baseline.test.ts",
    "src/bindings/shell-ready-formal.replay.test.ts",
    "src/app-root.shell-ready.test.tsx",
  ],
  "regression-after-fix.log",
);

const mainShell = mainShellSource();
writeFileSync(join(logDir, "main-shell-ready.ts"), mainShell);

const fixedDist = join(pagesRoot, "dist");
const baselineDist = join(pagesRoot, "work", "shell-ready-before");

if (process.env.VERIFY_SKIP_BUILD !== "1") {
  buildDist(mainShell, baselineDist);
  buildDist(readFileSync(shellReadyPath, "utf8"));
}

profileProof(join(outRoot, "profiles-after"), fixedDist);
profileProof(join(outRoot, "profiles-before"), baselineDist);
await playwrightConsent(fixedDist, "after", false);
await playwrightConsent(baselineDist, "before", true);
console.log(`Evidence: ${outRoot}`);
