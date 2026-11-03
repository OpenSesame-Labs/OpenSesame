/**
 * Slim headless automation: playwright-core driving an external Chromium binary
 * (system Chrome, chrome-headless-shell, or Playwright's headless-shell cache).
 * No `playwright install` or bundled browser download from this module.
 */
import { findChromium } from "./find-chromium.mjs";

/**
 * @param {{ args?: string[], executablePath?: string }} [options]
 */
export async function launchHeadlessPlaywright(options = {}) {
  const discovery = findChromium();
  const executablePath = options.executablePath ?? discovery.path ?? undefined;
  if (executablePath === undefined) {
    throw new Error(
      `no headless Chromium binary (probed ${discovery.probed.length} paths)`,
    );
  }
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage", ...(options.args ?? [])],
  });
  return { browser, discovery: { ...discovery, path: executablePath } };
}
