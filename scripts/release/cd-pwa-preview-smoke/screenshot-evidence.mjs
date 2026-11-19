/**
 * Deterministic headless screenshots of the live Pages Preview deploy.
 * Single browser, single context, one page — no retry sleeps. Hurl and the
 * shell-asset poll already ran. A failed step after the page exists still
 * writes failure evidence for the CI artifact upload.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launchHeadlessPlaywright } from "../../../apps/pages/scripts/duress/headless-playwright.mjs";
import { readString } from "../../lib/json-boundary.mjs";
import { normalizePagesBase } from "./prepare-vars.mjs";
import {
  bootstrapSmokeEvidence,
  redactDiagnosticText,
} from "./smoke-failure-evidence.mjs";

/**
 * The shell document `pages.hurl` proves:
 * `{{pages_base}}index.html?release={{github_sha}}`.
 * The directory URL stays cacheable on its own; this request carries the same
 * release query so the CDN cannot answer with a stale shell.
 */
export function smokeBrowserEntryUrl(pagesBase, sha) {
  const url = new URL("index.html", normalizePagesBase(pagesBase));
  url.searchParams.set("release", sha);
  return url.href;
}

async function sha256File(path) {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadFindChromium(repoRoot) {
  const mod = await import(
    pathToFileURL(join(repoRoot, "apps/pages/scripts/duress/find-chromium.mjs"))
      .href
  );
  return mod.findChromium;
}

/** Validated inputs: Pages base, release sha, output and repository roots. */
function readCaptureInputs(env) {
  const pagesBase = normalizePagesBase(env.PAGES_URL);
  const sha = readString(env.GITHUB_SHA);
  if (sha === undefined || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error("Pages smoke requires GITHUB_SHA");
  }
  const outRaw = readString(env.SMOKE_EVIDENCE_OUT);
  if (outRaw === undefined || outRaw.length === 0) {
    throw new Error("SMOKE_EVIDENCE_OUT is required");
  }
  const outRoot = resolve(outRaw);
  const repoRoot = resolve(readString(env.GITHUB_WORKSPACE) ?? process.cwd());
  return { pagesBase, sha, outRoot, repoRoot };
}

/** Front door: "Set up your own" is visible and no guest road is offered. */
async function captureFrontDoor(page, outRoot) {
  const setupOwn = page.getByRole("button", {
    name: "Set up your own",
    exact: true,
  });
  await setupOwn.waitFor({ state: "visible", timeout: 20_000 });
  const frontPath = join(outRoot, "live-front-door.png");
  await page.screenshot({ path: frontPath, animations: "disabled" });

  const guestOnDoor = await page
    .getByRole("button", { name: "Continue as guest", exact: true })
    .count();
  if (guestOnDoor !== 0) {
    throw new Error("live front door must not offer Continue as guest");
  }
  return { setupOwn, frontPath };
}

/** Setup choices: Minimal and Full are both offered after "Set up your own". */
async function captureSetupChoices(page, setupOwn, outRoot) {
  await setupOwn.click();
  await page
    .getByRole("button", { name: "Minimal", exact: true })
    .waitFor({ state: "visible", timeout: 15_000 });
  const fullChoice = page.getByRole("button", { name: "Full", exact: true });
  await fullChoice.waitFor({ state: "visible", timeout: 15_000 });
  const choicesPath = join(outRoot, "live-setup-choices-full.png");
  await page.screenshot({ path: choicesPath, animations: "disabled" });

  const fullCount = await fullChoice.count();
  if (fullCount !== 1) {
    throw new Error("Full install profile choice missing on live Pages");
  }
  return { fullChoice, choicesPath };
}

/** Full profile sign-in: no guest button, and the no-account road is there. */
async function captureFullSignInRoad(page, fullChoice, outRoot) {
  await fullChoice.click();
  await page
    .getByRole("heading", { level: 1, name: "Sign in" })
    .waitFor({ state: "visible", timeout: 20_000 });
  const guestContinue = await page
    .getByRole("button", { name: "Continue as guest", exact: true })
    .count();
  if (guestContinue !== 0) {
    throw new Error("Full profile sign-in must not offer Continue as guest");
  }
  const withoutAccount = await page.getByText("Use without an account").count();
  if (withoutAccount === 0) {
    throw new Error("Full profile sign-in road missing on live Pages");
  }
  const guestPath = join(outRoot, "live-full-sign-in-road.png");
  await page.screenshot({ path: guestPath, animations: "disabled" });
  return guestPath;
}

const MAX_DIAGNOSTIC_ENTRIES = 200;

function truncateEntry(entry) {
  const out = { ...entry };
  for (const key of ["text", "url", "error"]) {
    const text = readString(out[key]);
    if (text !== undefined) out[key] = redactDiagnosticText(text);
  }
  return out;
}

/** Ring buffer: newest events win when the cap is reached. */
export function pushDiagnostic(entries, entry) {
  const next = truncateEntry(entry);
  if (entries.length < MAX_DIAGNOSTIC_ENTRIES) {
    entries.push(next);
    return;
  }
  entries.shift();
  entries.push(next);
}

function callMethod(target, name) {
  try {
    const method = target[name];
    return method.call(target);
  } catch {
    return undefined;
  }
}

/** Console and network events from the live page, for a failed capture. */
function recordPageDiagnostics(page, consoleEntries, networkEntries) {
  try {
    page.on("console", (message) => {
      pushDiagnostic(consoleEntries, {
        type: callMethod(message, "type") ?? "log",
        text: String(callMethod(message, "text") ?? ""),
      });
    });
    page.on("pageerror", (error) => {
      const text =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      pushDiagnostic(consoleEntries, {
        type: "pageerror",
        text: text.slice(0, 2_000),
      });
    });
    page.on("response", (response) => {
      const request = callMethod(response, "request");
      pushDiagnostic(networkEntries, {
        url: String(callMethod(response, "url") ?? ""),
        status: callMethod(response, "status") ?? 0,
        method: String(callMethod(request, "method") ?? "GET"),
      });
    });
    page.on("requestfailed", (request) => {
      const failure = callMethod(request, "failure");
      pushDiagnostic(networkEntries, {
        url: String(callMethod(request, "url") ?? ""),
        method: String(callMethod(request, "method") ?? "GET"),
        error: readString(failure?.errorText) ?? "failed",
      });
    });
  } catch {
    // Stub pages in unit tests do not implement Playwright event wiring.
  }
}

async function writeFailureFiles(
  outRoot,
  consoleEntries,
  networkEntries,
  error,
) {
  const message =
    error instanceof Error ? error.message : "preview smoke capture failed";
  const body = (entries) =>
    `${JSON.stringify({ error: message, entries }, null, 2)}\n`;
  await writeFile(join(outRoot, "failure-console.json"), body(consoleEntries));
  await writeFile(join(outRoot, "failure-network.json"), body(networkEntries));
}

async function writeFailureEvidence(
  page,
  outRoot,
  consoleEntries,
  networkEntries,
  error,
) {
  try {
    await page.screenshot({
      path: join(outRoot, "failure-screenshot.png"),
      animations: "disabled",
    });
  } catch (shotError) {
    const text =
      shotError instanceof Error
        ? shotError.message
        : "failure screenshot failed";
    pushDiagnostic(consoleEntries, { type: "evidence", text });
  }
  await writeFailureFiles(outRoot, consoleEntries, networkEntries, error);
}

async function writePrePageFailureEvidence(outRoot, error, consoleEntries) {
  await writeFailureFiles(outRoot, consoleEntries, [], error);
}

export async function captureLiveSmokeEvidence(env, deps = {}) {
  const { pagesBase, sha, outRoot, repoRoot } = readCaptureInputs(env);
  const findChromium = deps.findChromium ?? (await loadFindChromium(repoRoot));
  if (deps.launchHeadlessPlaywright === undefined) {
    const discovery = findChromium();
    if (!discovery.path) {
      throw new Error("no Chromium binary for preview smoke screenshots");
    }
    process.env.PLAYWRIGHT_CHROMIUM = discovery.path;
  }

  await bootstrapSmokeEvidence(env);
  const started = Date.now();
  const consoleEntries = [];
  const networkEntries = [];
  const launch =
    deps.launchHeadlessPlaywright ??
    (async () =>
      launchHeadlessPlaywright({
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      }));
  let browser;
  let page;
  try {
    ({ browser } = await launch());
  } catch (launchError) {
    await writePrePageFailureEvidence(outRoot, launchError, consoleEntries);
    if (launchError instanceof Error) launchError.phaseWritten = true;
    throw launchError;
  }
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    page = await context.newPage();
    recordPageDiagnostics(page, consoleEntries, networkEntries);
    const entryUrl = smokeBrowserEntryUrl(pagesBase, sha);
    await page.goto(entryUrl, {
      waitUntil: "load",
      timeout: 45_000,
    });
    const { setupOwn, frontPath } = await captureFrontDoor(page, outRoot);
    const { fullChoice, choicesPath } = await captureSetupChoices(
      page,
      setupOwn,
      outRoot,
    );
    const guestPath = await captureFullSignInRoad(page, fullChoice, outRoot);

    const manifest = {
      format: "cd-pwa-preview-smoke-evidence",
      version: 1,
      revision: sha,
      pages_url: pagesBase,
      browser_entry_url: entryUrl,
      captured_ms: Date.now() - started,
      shots: {
        "live-front-door.png": await sha256File(frontPath),
        "live-setup-choices-full.png": await sha256File(choicesPath),
        "live-full-sign-in-road.png": await sha256File(guestPath),
      },
    };
    await writeFile(
      join(outRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return manifest;
  } catch (error) {
    try {
      if (page !== undefined) {
        await writeFailureEvidence(
          page,
          outRoot,
          consoleEntries,
          networkEntries,
          error,
        );
      } else {
        await writePrePageFailureEvidence(outRoot, error, consoleEntries);
      }
      if (error instanceof Error) error.phaseWritten = true;
    } catch (evidenceError) {
      const text =
        evidenceError instanceof Error
          ? evidenceError.message
          : "failure evidence was not written";
      console.error(text);
    }
    throw error;
  } finally {
    await browser?.close();
  }
}
