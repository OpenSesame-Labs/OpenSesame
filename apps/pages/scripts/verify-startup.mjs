// Exercise the built entry before and after JavaScript, including a return
// visit whose correct screen is different from a fresh device's front door.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { serveLoopbackDist } from "./lib/static-origin-harness.mjs";
import { verifyControlledStartup } from "./lib/verify-startup-controlled.mjs";

const dist =
  process.env.PAGES_VERIFY_DIST ??
  fileURLToPath(new URL("../dist", import.meta.url));
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const out = process.env.PAGES_VERIFY_OUT;
if (out) mkdirSync(out, { recursive: true });
const server = await serveLoopbackDist({ dist, base });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  headless: true,
});

async function screenshot(page, name) {
  if (out) await page.screenshot({ path: join(out, `${name}.png`) });
}

try {
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  const noJsPage = await noJs.newPage();
  await noJsPage.goto(server.href);
  assert.match(await noJsPage.locator("body").innerText(), /needs JavaScript/);
  assert.equal(await noJsPage.getByRole("button").count(), 0);
  assert.equal(await noJsPage.locator(".boot__status:visible").count(), 0);
  await screenshot(noJsPage, "startup-no-javascript");
  await noJs.close();

  const dark = await browser.newContext({
    javaScriptEnabled: false,
    colorScheme: "dark",
    viewport: { width: 390, height: 844 },
  });
  const darkPage = await dark.newPage();
  await darkPage.goto(server.href);
  assert.equal(
    await darkPage
      .locator("body")
      .evaluate((body) => getComputedStyle(body).backgroundColor),
    "rgb(15, 15, 15)",
  );
  await screenshot(darkPage, "startup-dark-no-javascript");
  await dark.close();

  // The entry can fail when a single eager dependency is temporarily missing.
  // Exercise an actual failed module request, then a real retry/navigation.
  const transient = await browser.newContext({ serviceWorkers: "block" });
  const transientPage = await transient.newPage();
  let entryRequests = 0;
  let failNextEntry = true;
  await transientPage.route("**/assets/main-*.js", (route) => {
    entryRequests += 1;
    if (failNextEntry) {
      failNextEntry = false;
      return route.fulfill({ status: 503 });
    }
    return route.continue();
  });
  await transientPage.goto(server.href, { waitUntil: "commit" });
  await transientPage
    .getByRole("button", { name: "Set up your own", exact: true })
    .waitFor({ timeout: 30_000 });
  assert.equal(entryRequests, 2, "one failed entry gets one automatic retry");
  assert.equal(
    await transientPage.evaluate(() =>
      sessionStorage.getItem("os-entry-load-retry"),
    ),
    null,
    "a successful start makes a later failure eligible for a retry",
  );
  failNextEntry = true;
  await transientPage.reload({ waitUntil: "commit" });
  await transientPage
    .getByRole("button", { name: "Set up your own", exact: true })
    .waitFor({ timeout: 30_000 });
  assert.equal(entryRequests, 4, "a later visit can recover independently");
  await transient.close();

  const failedEntry = await browser.newContext({ serviceWorkers: "block" });
  const failedPage = await failedEntry.newPage();
  let failedRequests = 0;
  await failedPage.route("**/assets/main-*.js", (route) => {
    failedRequests += 1;
    return route.abort();
  });
  await failedPage.goto(server.href, { waitUntil: "commit" });
  const failure = failedPage.getByRole("alert");
  await failure.waitFor({ state: "visible", timeout: 15_000 });
  assert.match(await failure.innerText(), /could not start/);
  await failedPage.waitForTimeout(1_000);
  assert.equal(failedRequests, 2, "a persistent failure must stop retrying");
  await failedEntry.close();

  const noStorage = await browser.newContext({ serviceWorkers: "block" });
  await noStorage.addInitScript(() => {
    Object.defineProperty(window, "sessionStorage", {
      get() {
        throw new DOMException("Storage unavailable", "SecurityError");
      },
    });
  });
  const noStoragePage = await noStorage.newPage();
  let noStorageRequests = 0;
  await noStoragePage.route("**/assets/main-*.js", (route) => {
    noStorageRequests += 1;
    return route.abort();
  });
  await noStoragePage.goto(server.href, { waitUntil: "commit" });
  await noStoragePage.getByRole("alert").waitFor({ timeout: 15_000 });
  await noStoragePage.waitForTimeout(1_000);
  assert.equal(noStorageRequests, 1, "without storage, do not reload forever");
  await noStorage.close();

  // A dependency of the entry can fail before the entry module evaluates too.
  // Abort a real static import from the built module rather than simulating a
  // bootstrap exception after the application has already begun to run.
  const builtHtml = readFileSync(join(dist, "index.html"), "utf8");
  const entryPath = builtHtml.match(
    /src="([^"]*\/assets\/main-[\w-]+\.js)"/u,
  )?.[1];
  assert.ok(entryPath, "built HTML must identify the app entry module");
  const entrySource = readFileSync(
    join(dist, "assets", basename(entryPath)),
    "utf8",
  );
  const eagerImport = entrySource.match(
    /\b(?:from|import)\s*["'](\.[^"']+\.js)["']/u,
  )?.[1];
  if (eagerImport) {
    const dependencyPath = new URL(eagerImport, new URL(entryPath, server.href))
      .pathname;
    const transientDependency = await browser.newContext({
      serviceWorkers: "block",
    });
    const transientDependencyPage = await transientDependency.newPage();
    let dependencyRequests = 0;
    await transientDependencyPage.route(`**${dependencyPath}`, (route) => {
      dependencyRequests += 1;
      return dependencyRequests === 1
        ? route.fulfill({ status: 503 })
        : route.continue();
    });
    await transientDependencyPage.goto(server.href, { waitUntil: "commit" });
    await transientDependencyPage
      .getByRole("button", { name: "Set up your own", exact: true })
      .waitFor({ timeout: 30_000 });
    assert.equal(dependencyRequests, 2, "a temporary eager failure recovers");
    await transientDependency.close();
    await verifyControlledStartup(browser, server.href, dependencyPath);
    const failedDependency = await browser.newContext({
      serviceWorkers: "block",
    });
    const dependencyPage = await failedDependency.newPage();
    await dependencyPage.route(`**${dependencyPath}`, (route) => route.abort());
    await dependencyPage.goto(server.href, { waitUntil: "commit" });
    const dependencyFailure = dependencyPage.getByRole("alert");
    await dependencyFailure.waitFor({ state: "visible", timeout: 15_000 });
    assert.match(await dependencyFailure.innerText(), /could not start/);
    await failedDependency.close();
    console.log("PASS: failed eager module shows a startup error");
  } else {
    console.log("SKIP: the built entry has no static module dependency");
  }

  const splitBootstrap = entrySource.match(
    /\b(?:from|import)\s*["']\.\/(pages-[A-Za-z0-9_-]{8,64}\.js)["']/u,
  )?.[1];
  const pushWorker = join(dist, "sw-push.js");
  if (splitBootstrap && existsSync(pushWorker)) {
    assert.ok(
      readFileSync(pushWorker, "utf8").includes(`assets/${splitBootstrap}`),
      "the push worker must recognize the executing bootstrap chunk",
    );
  }

  // When the host already supplies COOP/COEP, a first worker claim for this
  // same build must not navigate away from the page the person is using.
  const isolatedServer = await serveLoopbackDist({
    dist,
    base,
    headers: {
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "same-origin",
    },
  });
  const isolated = await browser.newContext();
  try {
    await isolated.addInitScript(() => {
      const key = "__startup_claim_check";
      sessionStorage.setItem(
        key,
        String(Number(sessionStorage.getItem(key) ?? "0") + 1),
      );
    });
    const isolatedPage = await isolated.newPage();
    await isolatedPage.goto(isolatedServer.href, {
      waitUntil: "domcontentloaded",
    });
    await isolatedPage.waitForFunction(
      () => crossOriginIsolated && Boolean(navigator.serviceWorker?.controller),
      null,
      { timeout: 30_000 },
    );
    await isolatedPage
      .getByRole("button", { name: "Set up your own", exact: true })
      .waitFor({ timeout: 30_000 });
    await isolatedPage.waitForTimeout(3_000);
    assert.equal(
      await isolatedPage.evaluate(() =>
        Number(sessionStorage.getItem("__startup_claim_check")),
      ),
      1,
      "a compatible first worker claim must not reload an isolated page",
    );
    console.log("PASS: an isolated first worker claim keeps the page");
  } finally {
    await isolated.close();
    await isolatedServer.close();
  }

  // A lazy chunk can fail after the shell has already loaded. Keep the file
  // unavailable across a real navigation and ensure the same build stops
  // retrying instead of clearing its guard on every successful shell import.
  const stale = await browser.newContext({ serviceWorkers: "block" });
  await stale.addInitScript(() => {
    const key = "__startup_reload_check";
    sessionStorage.setItem(
      key,
      String(Number(sessionStorage.getItem(key) ?? "0") + 1),
    );
  });
  const stalePage = await stale.newPage();
  let failedChunks = 0;
  await stalePage.route("**/assets/VaultSection-*.js", (route) => {
    failedChunks += 1;
    return route.abort();
  });
  await stalePage.goto(server.href, { waitUntil: "domcontentloaded" });
  await stalePage.waitForFunction(
    () => Number(sessionStorage.getItem("__startup_reload_check")) >= 2,
    null,
    { timeout: 30_000 },
  );
  await stalePage
    .getByRole("button", { name: "Set up your own", exact: true })
    .waitFor({ timeout: 30_000 });
  const stop = Date.now() + 15_000;
  while (failedChunks < 2 && Date.now() < stop)
    await stalePage.waitForTimeout(100);
  assert.ok(failedChunks >= 2, "the same lazy chunk failed on both documents");
  await stalePage.waitForTimeout(2_000);
  assert.equal(
    await stalePage.evaluate(() =>
      Number(sessionStorage.getItem("__startup_reload_check")),
    ),
    2,
    "an unavailable lazy chunk must not reload the same build repeatedly",
  );
  await stalePage
    .getByRole("heading", { name: "Notification: Out of date" })
    .waitFor({
      state: "visible",
      timeout: 15_000,
    });
  await screenshot(stalePage, "startup-stale-chunk");
  await stale.close();
  console.log("PASS: a missing lazy chunk gets one automatic retry");

  for (const device of [
    { name: "desktop", viewport: { width: 1365, height: 900 } },
    {
      name: "phone",
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    },
  ]) {
    const { name, ...options } = device;
    const context = await browser.newContext({
      ...options,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let releaseEntry;
    const entryHeld = new Promise((resolve) => {
      releaseEntry = resolve;
    });
    await page.route("**/assets/main-*.js", async (route) => {
      await entryHeld;
      await route.continue();
    });
    await page.goto(server.href, { waitUntil: "commit" });
    const status = page.getByRole("status");
    await status.waitFor({ state: "visible", timeout: 15_000 });
    assert.match(await status.innerText(), /Opening OpenSesame/);
    await page.locator(".boot__wordmark").waitFor({
      state: "visible",
      timeout: 15_000,
    });
    assert.match(
      await page.locator(".boot__wordmark text").textContent(),
      /OPEN SESAME/,
    );
    const lede = await page.locator(".boot__lede").innerText();
    const notesTitle = await page.locator(".boot__notes h2").innerText();
    assert.equal(await page.getByRole("button").count(), 0);
    await screenshot(page, `${name}-opening`);
    releaseEntry();

    const setup = page.getByRole("button", {
      name: "Set up your own",
      exact: true,
    });
    await setup.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.locator(".boot").count(), 0);
    assert.equal(await page.locator(".door__lede").innerText(), lede);
    assert.equal(
      await page.locator(".unlock__notes-title").innerText(),
      notesTitle,
    );
    for (const road of [
      "Join a session",
      "Import passwords from a file",
      "Skip sign-in and continue as guest",
    ]) {
      await page.getByRole("button", { name: road }).waitFor({
        state: "visible",
        timeout: 30_000,
      });
      assert.equal(
        await page.getByRole("button", { name: road }).count(),
        1,
        road,
      );
    }
    await screenshot(page, `${name}-front-door`);

    // A real action changes the device's setup state. After a reload, the
    // startup state must yield to sign-in rather than a hard-coded front door.
    await setup.click();
    await page.getByRole("button", { name: "Skip all" }).click();
    await page
      .getByRole("button", { name: "Use without an account" })
      .waitFor({ timeout: 30_000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "Use without an account" })
      .waitFor({ timeout: 30_000 });
    assert.equal(await setup.count(), 0);
    assert.deepEqual(errors, []);
    await screenshot(page, `${name}-returning`);
    await context.close();
    console.log(`PASS: ${name} startup, front door and returning visit`);
  }
} finally {
  await browser.close();
  await server.close();
}
