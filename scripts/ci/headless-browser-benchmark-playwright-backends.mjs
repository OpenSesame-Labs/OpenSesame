/**
 * Headless browser benchmark backends that drive a Chromium binary through
 * playwright-core: system Chromium, Chrome for Testing headless shell, and
 * the two Playwright-managed installs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  dirSizeBytes,
  repoRoot,
  resolveBenchDist,
  serveDist,
  timedAsync,
} from "./headless-browser-benchmark-support.mjs";

const CHROME_VERSION = "156.0.8078.4";

async function captureThreeWithPlaywrightCore(executablePath, pageUrl, outDir) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });
    await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    const paths = [
      join(outDir, "shot-1.png"),
      join(outDir, "shot-2.png"),
      join(outDir, "shot-3.png"),
    ];
    await page.screenshot({ path: paths[0], animations: "disabled" });
    await page.evaluate(() => window.scrollTo(0, 200));
    await page.screenshot({ path: paths[1], animations: "disabled" });
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.screenshot({ path: paths[2], animations: "disabled" });
    for (const p of paths) {
      const bytes = readFileSync(p);
      if (bytes.length < 1000) {
        throw new Error(`screenshot too small: ${p}`);
      }
    }
    return paths;
  } finally {
    await browser.close();
  }
}

async function runPlaywrightCoreBench(label, prepare) {
  const row = {
    backend: label,
    install_bytes: 0,
    install_ms: 0,
    capture_ms: 0,
    dom_assert_ms: 0,
    screenshots_ok: false,
    dom_assert_ok: false,
    notes: "",
  };
  const dist = resolveBenchDist();
  if (dist === null) {
    row.notes = "skipped: no apps/pages/dist for bench";
    return row;
  }
  let cacheDir = "";
  try {
    const prepared = await timedAsync(async () => prepare());
    row.install_ms = prepared.ms;
    cacheDir = prepared.value.cacheDir;
    row.install_bytes = prepared.value.installBytes;
    const server = await serveDist(dist);
    const outDir = mkdtempSync(join(tmpdir(), "headless-bench-"));
    try {
      const capture = await timedAsync(async () =>
        captureThreeWithPlaywrightCore(
          prepared.value.executablePath,
          server.href,
          outDir,
        ),
      );
      row.capture_ms = capture.ms;
      row.screenshots_ok = true;
      row.notes = `shots=${capture.value.length}`;
    } finally {
      await server.close();
      rmSync(outDir, { recursive: true, force: true });
    }
  } catch (error) {
    row.notes = error instanceof Error ? error.message : "bench failed";
  } finally {
    if (cacheDir.length > 0 && cacheDir.includes("/tmp/")) {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  }
  return row;
}

export async function benchSystemChromium() {
  return runPlaywrightCoreBench(
    "playwright-core + system chromium",
    async () => {
      const candidates = [
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome-stable",
      ];
      const hit = candidates.find((p) => existsSync(p));
      if (hit === undefined) {
        throw new Error("system chromium not installed");
      }
      return { executablePath: hit, cacheDir: "", installBytes: 0 };
    },
  );
}

export async function benchCftHeadlessShell() {
  return runPlaywrightCoreBench(
    "playwright-core + @puppeteer/browsers chrome-headless-shell",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "cft-shell-"));
      const ran = spawnSync(
        "npx",
        [
          "--yes",
          "@puppeteer/browsers@3.2.6",
          "install",
          `chrome-headless-shell@${CHROME_VERSION}`,
          "--path",
          cacheDir,
        ],
        { cwd: repoRoot, stdio: "pipe", encoding: "utf8" },
      );
      if (ran.status !== 0) {
        throw new Error(ran.stderr || "cft install failed");
      }
      const executablePath = join(
        cacheDir,
        "chrome-headless-shell",
        `linux-${CHROME_VERSION}`,
        "chrome-headless-shell-linux64",
        "chrome-headless-shell",
      );
      if (!existsSync(executablePath)) {
        throw new Error("cft binary missing after install");
      }
      return {
        executablePath,
        cacheDir,
        installBytes: dirSizeBytes(cacheDir),
      };
    },
  );
}

export async function benchPlaywrightHeadlessShell() {
  return runPlaywrightCoreBench(
    "playwright-core + playwright install chromium-headless-shell",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "pw-hshell-"));
      const ran = spawnSync(
        "npx",
        ["playwright", "install", "chromium-headless-shell"],
        {
          cwd: repoRoot,
          stdio: "pipe",
          encoding: "utf8",
          env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cacheDir },
        },
      );
      if (ran.status !== 0) {
        throw new Error(
          ran.stderr || "playwright headless-shell install failed",
        );
      }
      const { findChromium } = await import(
        pathToFileURL(
          join(repoRoot, "apps/pages/scripts/duress/find-chromium.mjs"),
        ).href
      );
      process.env.PLAYWRIGHT_CHROMIUM = "";
      process.env.HOME = process.env.HOME ?? tmpdir();
      const prev = process.env.PLAYWRIGHT_BROWSERS_PATH;
      process.env.PLAYWRIGHT_BROWSERS_PATH = cacheDir;
      const discovery = findChromium();
      process.env.PLAYWRIGHT_BROWSERS_PATH = prev;
      if (!discovery.path) {
        throw new Error("playwright headless-shell binary not discovered");
      }
      return {
        executablePath: discovery.path,
        cacheDir,
        installBytes: dirSizeBytes(cacheDir),
      };
    },
  );
}

export async function benchPlaywrightFullChromium() {
  return runPlaywrightCoreBench(
    "playwright-core + playwright install chromium",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "pw-chromium-"));
      const ran = spawnSync("npx", ["playwright", "install", "chromium"], {
        cwd: repoRoot,
        stdio: "pipe",
        encoding: "utf8",
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cacheDir },
      });
      if (ran.status !== 0) {
        throw new Error(ran.stderr || "playwright chromium install failed");
      }
      const { findChromium } = await import(
        pathToFileURL(
          join(repoRoot, "apps/pages/scripts/duress/find-chromium.mjs"),
        ).href
      );
      const prev = process.env.PLAYWRIGHT_BROWSERS_PATH;
      process.env.PLAYWRIGHT_BROWSERS_PATH = cacheDir;
      const discovery = findChromium();
      process.env.PLAYWRIGHT_BROWSERS_PATH = prev;
      if (!discovery.path) {
        throw new Error("playwright chromium binary not discovered");
      }
      return {
        executablePath: discovery.path,
        cacheDir,
        installBytes: dirSizeBytes(cacheDir),
      };
    },
  );
}
