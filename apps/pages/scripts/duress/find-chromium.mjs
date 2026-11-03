import { spawnSync } from "node:child_process";
/**
 * Honest Chromium discovery for duress browser journeys.
 * Never invents a path; returns null when nothing usable exists.
 */
import fs from "node:fs";
import path from "node:path";

const CANDIDATE_ENV = ["PLAYWRIGHT_CHROMIUM", "CHROMIUM_PATH", "CHROME_PATH"];

const FIXED_CANDIDATES = [
  "/opt/pw-browsers/chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

function existsExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function playwrightCacheCandidates() {
  const roots = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  }
  roots.push(path.join(process.env.HOME ?? "", ".cache/ms-playwright"));
  const out = [];
  for (const cache of roots) {
    if (!fs.existsSync(cache)) continue;
    for (const name of fs.readdirSync(cache).sort().reverse()) {
      if (!name.startsWith("chromium")) continue;
      const root = path.join(cache, name);
      for (const rel of [
        "chrome-headless-shell-linux64/chrome-headless-shell",
        "chrome-linux-arm64/chrome",
        "chrome-linux/chrome",
        "chrome-linux64/chrome",
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        "chrome-win/chrome.exe",
      ]) {
        out.push(path.join(root, rel));
      }
    }
  }
  return out;
}

/**
 * @returns {{ path: string | null, source: string | null, probed: string[], version: string | null }}
 */
export function findChromium() {
  const probed = [];
  const tryPath = (candidate, source) => {
    probed.push(candidate);
    if (!candidate || !existsExecutable(candidate)) return null;
    const ver = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return {
      path: candidate,
      source,
      probed,
      version: (ver.stdout || ver.stderr || "").trim() || null,
    };
  };

  for (const envName of CANDIDATE_ENV) {
    const value = process.env[envName];
    if (!value) {
      probed.push(`env:${envName}=(unset)`);
      continue;
    }
    const hit = tryPath(value, `env:${envName}`);
    if (hit) return hit;
  }

  for (const candidate of FIXED_CANDIDATES) {
    const hit = tryPath(candidate, "fixed");
    if (hit) return hit;
  }

  for (const candidate of playwrightCacheCandidates()) {
    const hit = tryPath(candidate, "ms-playwright-cache");
    if (hit) return hit;
  }

  const shellCache = path.join(
    process.cwd(),
    ".cache",
    "cd-chrome-headless-shell",
  );
  if (fs.existsSync(shellCache)) {
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, name.name);
        if (name.isDirectory()) walk(full);
        else if (name.name === "chrome-headless-shell") {
          const hit = tryPath(full, "cd-chrome-headless-shell-cache");
          if (hit) return hit;
        }
      }
      return null;
    };
    const shellHit = walk(shellCache);
    if (shellHit) return shellHit;
  }

  return { path: null, source: null, probed, version: null };
}

export function applyChromiumEnv(discovery = findChromium()) {
  if (discovery.path && !process.env.PLAYWRIGHT_CHROMIUM) {
    process.env.PLAYWRIGHT_CHROMIUM = discovery.path;
  }
  return discovery;
}
