/**
 * Deterministic headless screenshots of the live Pages Preview deploy.
 * Single browser, single context, one page — no retry sleeps (Hurl already polled CDN).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { readString } from "../../lib/json-boundary.mjs";
import { normalizePagesBase } from "./prepare-vars.mjs";

async function sha256File(path) {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadFindChromium(repoRoot) {
  const mod = await import(
    pathToFileURL(
      join(repoRoot, "apps/pages/scripts/duress/find-chromium.mjs"),
    ).href
  );
  return mod.findChromium;
}

export async function captureLiveSmokeEvidence(env, deps = {}) {
  const pagesUrl = normalizePagesBase(env.PAGES_URL);
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
  const findChromium = deps.findChromium ?? (await loadFindChromium(repoRoot));
  const discovery = findChromium();
  if (!discovery.path) {
    throw new Error("no Chromium binary for preview smoke screenshots");
  }

  await mkdir(outRoot, { recursive: true });
  const started = Date.now();
  const browser = await chromium.launch({
    headless: true,
    executablePath: discovery.path,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(pagesUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
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

    await setupOwn.click();
    const fullChoice = page.getByRole("button", { name: "Full", exact: true });
    await fullChoice.waitFor({ state: "visible", timeout: 15_000 });
    const choicesPath = join(outRoot, "live-setup-choices-full.png");
    await page.screenshot({ path: choicesPath, animations: "disabled" });

    const fullCount = await fullChoice.count();
    if (fullCount !== 1) {
      throw new Error("Full install profile choice missing on live Pages");
    }

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

    const manifest = {
      format: "cd-pwa-preview-smoke-evidence",
      version: 1,
      revision: sha,
      pages_url: pagesUrl,
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
  } finally {
    await browser.close();
  }
}
