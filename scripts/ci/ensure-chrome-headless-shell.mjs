#!/usr/bin/env node
/**
 * Ensure a CDP-capable headless shell exists without `playwright install`.
 * Prefers system Chromium; otherwise downloads chrome-headless-shell via
 * @puppeteer/browsers (same Chrome for Testing version as Playwright 1.64).
 *
 * Prints the executable path on stdout for GITHUB_ENV / PLAYWRIGHT_CHROMIUM.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHROME_VERSION = "156.0.8078.4";
const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function findSystemChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM,
    process.env.CHROME_HEADLESS_SHELL_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const path = String(candidate);
    if (path.length === 0) continue;
    if (!existsSync(path)) continue;
    return path;
  }
  return null;
}

function installHeadlessShell(cacheRoot) {
  mkdirSync(cacheRoot, { recursive: true });
  const ran = spawnSync(
    "npx",
    [
      "--yes",
      "@puppeteer/browsers@3.2.6",
      "install",
      `chrome-headless-shell@${CHROME_VERSION}`,
      "--path",
      cacheRoot,
    ],
    { cwd: repoRoot, stdio: "inherit", env: process.env },
  );
  if (ran.error) throw ran.error;
  if (ran.status !== 0) {
    throw new Error("chrome-headless-shell install failed");
  }
  const binary = join(
    cacheRoot,
    "chrome-headless-shell",
    `linux-${CHROME_VERSION}`,
    "chrome-headless-shell-linux64",
    "chrome-headless-shell",
  );
  if (!existsSync(binary)) {
    throw new Error(`missing chrome-headless-shell after install: ${binary}`);
  }
  return binary;
}

function main() {
  const system = findSystemChromium();
  if (system !== null) {
    process.stdout.write(`${system}\n`);
    return;
  }
  const cacheRoot =
    process.env.CD_CHROME_HEADLESS_CACHE ??
    join(repoRoot, ".cache", "cd-chrome-headless-shell");
  const cached = join(
    cacheRoot,
    "chrome-headless-shell",
    `linux-${CHROME_VERSION}`,
    "chrome-headless-shell-linux64",
    "chrome-headless-shell",
  );
  const path =
    existsSync(cached) && cached.length > 0
      ? cached
      : installHeadlessShell(cacheRoot);
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
