#!/usr/bin/env node
/**
 * Ensure a CDP-capable headless shell exists without `playwright install`.
 * Prefers system Chromium; otherwise downloads chrome-headless-shell via
 * @puppeteer/browsers (same Chrome for Testing version as Playwright 1.64).
 *
 * Prints the executable path on stdout for GITHUB_ENV / PLAYWRIGHT_CHROMIUM.
 * CD_PWA_SMOKE_REQUIRE_HEADLESS_SHELL=1 skips system Chromium, including
 * /usr/bin/chromium, and uses the cached or downloaded chrome-headless-shell.
 * Installer stdout is discarded so that path is the only stdout line.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHROME_VERSION = "156.0.8078.4";
const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const SYSTEM_CHROMIUM = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome-stable",
];

export function requiresHeadlessShell(env) {
  return env.CD_PWA_SMOKE_REQUIRE_HEADLESS_SHELL === "1";
}

export function findSystemChromium(env, exists = existsSync) {
  if (requiresHeadlessShell(env)) return null;
  const candidates = [
    env.PLAYWRIGHT_CHROMIUM,
    env.CHROME_HEADLESS_SHELL_PATH,
    ...SYSTEM_CHROMIUM,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const path = String(candidate);
    if (path.length === 0) continue;
    if (!exists(path)) continue;
    return path;
  }
  return null;
}

export function headlessShellCachePath(cacheRoot) {
  return join(
    cacheRoot,
    "chrome-headless-shell",
    `linux-${CHROME_VERSION}`,
    "chrome-headless-shell-linux64",
    "chrome-headless-shell",
  );
}

/** Install argv. Stdout is ignored so this process prints only the binary path. */
export function headlessShellInstallPlan(cacheRoot) {
  return {
    command: "npx",
    args: [
      "--yes",
      "@puppeteer/browsers@3.2.6",
      "install",
      `chrome-headless-shell@${CHROME_VERSION}`,
      "--path",
      cacheRoot,
    ],
    stdio: ["ignore", "ignore", "inherit"],
  };
}

export function resolveHeadlessShellBinary(env, exists, install) {
  const system = findSystemChromium(env, exists);
  if (system !== null) return system;
  const cacheRoot =
    env.CD_CHROME_HEADLESS_CACHE ??
    join(repoRoot, ".cache", "cd-chrome-headless-shell");
  const cached = headlessShellCachePath(cacheRoot);
  if (exists(cached)) return cached;
  return install(cacheRoot);
}

function installHeadlessShell(cacheRoot) {
  mkdirSync(cacheRoot, { recursive: true });
  const plan = headlessShellInstallPlan(cacheRoot);
  const ran = spawnSync(plan.command, plan.args, {
    cwd: repoRoot,
    stdio: plan.stdio,
    env: process.env,
  });
  if (ran.error) throw ran.error;
  if (ran.status !== 0) {
    throw new Error("chrome-headless-shell install failed");
  }
  const binary = headlessShellCachePath(cacheRoot);
  if (!existsSync(binary)) {
    throw new Error(`missing chrome-headless-shell after install: ${binary}`);
  }
  return binary;
}

function main() {
  const path = resolveHeadlessShellBinary(
    process.env,
    existsSync,
    installHeadlessShell,
  );
  process.stdout.write(`${path}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
