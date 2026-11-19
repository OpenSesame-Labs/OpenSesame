#!/usr/bin/env node
/** Check password generation and rotation feedback on a real mobile viewport. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { doorGuest } from "./lib/front-door.mjs";
import {
  lockVault,
  openSettingsCategory,
  sealWithPin,
  unlockWithPin,
} from "./lib/pages-journey.mjs";
import { privateTempDir } from "./lib/private-files.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const origin = "https://opensesame-labs.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const out =
  process.env.PAGES_VERIFY_OUT ?? privateTempDir("opensesame-rotation-mobile-");
const dist =
  process.env.PAGES_VERIFY_DIST ?? path.resolve(import.meta.dirname, "../dist");
const failure =
  "Rotation is queued and may retry. Its status could not be confirmed.";
fs.mkdirSync(out, { recursive: true });
const harness = createHarness({ dist, origin, base, out });
const browser = await harness.launch({
  args: process.env.PLAYWRIGHT_NO_SANDBOX
    ? ["--no-sandbox", "--disable-dev-shm-usage"]
    : [],
});

async function enableAccounts(page) {
  await openSettingsCategory(page, "Item types");
  const account = page.getByRole("switch", { name: "Account", exact: true });
  if ((await account.getAttribute("aria-checked")) !== "true")
    await account.click();
  await page.waitForFunction(() => {
    const control = document.querySelector(
      '[role="switch"][aria-label="Account"]',
    );
    return (
      control?.getAttribute("aria-checked") === "true" &&
      control.getAttribute("aria-busy") !== "true"
    );
  });
}

async function newAccount(page, name, website) {
  const query = website ? `?uri=${encodeURIComponent(website)}` : "";
  await page.evaluate((route) => {
    history.pushState(null, "", route);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}vault/new/account${query}`);
  await page.getByLabel("Name", { exact: true }).first().fill(name);
  await page.getByLabel("Username / ID", { exact: true }).fill("guest-user");
  await page.getByRole("button", { name: "Save item" }).first().click();
  await page.getByRole("heading", { level: 1, name }).waitFor();
}

async function generateAndCopy(page) {
  const name = "Guest mail";
  await newAccount(page, name, "https://mail.example.test");
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  const password = page.getByLabel("Password", { exact: true }).first();
  const before = await password.inputValue();
  await page.getByRole("button", { name: "Generate another password" }).tap();
  const generated = await password.inputValue();
  assert(
    generated && generated !== before,
    "editor generates a new local password",
  );
  await page.getByRole("button", { name: "Save item" }).click();
  await page.getByRole("heading", { level: 1, name }).waitFor();
  await page.getByRole("button", { name: "Copy password", exact: true }).tap();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    generated,
  );
}

async function openTray(page) {
  await page
    .getByRole("button", { name: /^Notifications/ })
    .filter({ visible: true })
    .first()
    .tap();
  const tray = page.getByRole("dialog", { name: "Notifications" });
  await tray.waitFor();
  return tray;
}

async function prepareFailingRotation(page) {
  await page.evaluate((route) => {
    history.pushState(null, "", route);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}vault/new/secret`);
  await page.getByLabel("Name", { exact: true }).first().fill("Service secret");
  await page.getByLabel("Secret value", { exact: true }).fill("example-secret");
  await page.getByRole("button", { name: "Save item" }).first().click();
  await page.getByRole("heading", { name: "Service secret" }).waitFor();
  await page.evaluate(() => {
    const original = navigator.locks.request;
    Object.defineProperty(window, "__rotationTestLock", {
      configurable: true,
      value: original,
    });
    Object.defineProperty(navigator.locks, "request", {
      configurable: true,
      value(name, ...args) {
        if (name === "opensesame:local-rotation")
          return Promise.reject(
            new Error("Simulated rotation storage failure"),
          );
        return original.call(navigator.locks, name, ...args);
      },
    });
  });
}

async function restoreRotationStorage(page) {
  await page.evaluate(() => {
    Object.defineProperty(navigator.locks, "request", {
      configurable: true,
      value: window.__rotationTestLock,
    });
    delete window.__rotationTestLock;
  });
}

function assertBubbleGeometry(bubbleBox, actionBox, viewport) {
  assert(
    bubbleBox &&
      viewport &&
      bubbleBox.x >= 0 &&
      bubbleBox.y >= 0 &&
      bubbleBox.x + bubbleBox.width <= viewport.width &&
      bubbleBox.y + bubbleBox.height <= viewport.height,
    "rotation failure detail fits in the viewport",
  );
  assert(
    bubbleBox &&
      actionBox &&
      (bubbleBox.y + bubbleBox.height <= actionBox.y ||
        actionBox.y + actionBox.height <= bubbleBox.y ||
        bubbleBox.x + bubbleBox.width <= actionBox.x ||
        actionBox.x + actionBox.width <= bubbleBox.x),
    "rotation failure detail does not cover the retry action",
  );
}

async function verifyRotationFailureRemoved(page, width) {
  await restoreRotationStorage(page);
  await lockVault(page);
  assert.equal(
    await page.getByText(failure, { exact: true }).count(),
    0,
    "rotation failure is cleared on the unlock screen",
  );
  await page.screenshot({
    path: path.join(out, `rotation-${width}-locked.png`),
    animations: "disabled",
  });
  await unlockWithPin(page);
  const freshTray = await openTray(page);
  assert.equal(await freshTray.getByText(failure, { exact: true }).count(), 0);
  await page.screenshot({
    path: path.join(out, `rotation-${width}-after-lock.png`),
    animations: "disabled",
  });
}

async function verifyFailureClearsOnLock(page, width) {
  await prepareFailingRotation(page);
  const action = page
    .getByRole("region", { name: "Rotation", exact: true })
    .getByRole("button", { name: "Request rotation" });
  await action.scrollIntoViewIfNeeded();
  const box = await action.boundingBox();
  assert(
    box && box.width >= 44 && box.height >= 44,
    "rotation key has a touch target",
  );
  await action.tap();
  const status = page
    .getByRole("region", { name: "Rotation", exact: true })
    .getByRole("img", { name: failure });
  await status.waitFor({ state: "visible" });
  assert.equal(
    await page
      .getByText("Rotation queued; waiting for the vault relay.")
      .count(),
    0,
    "a processing failure is not described as waiting for the relay",
  );
  const statusBox = await status.boundingBox();
  const actionBox = await action.boundingBox();
  assert(
    statusBox && statusBox.width >= 44 && statusBox.height >= 44,
    `failure detail has a touch target (${JSON.stringify(statusBox)})`,
  );
  assert(
    statusBox && actionBox && statusBox.x + statusBox.width <= actionBox.x,
    "failure detail and rotation action do not overlap",
  );
  await status.tap();
  const bubble = page.locator(".status-bubble").filter({ hasText: failure });
  await bubble.waitFor();
  const bubbleBox = await bubble.boundingBox();
  // Tapping the status mark may scroll it into view. Measure the retry key
  // again after the tap so both boxes describe the same viewport position.
  const retryBox = await action.boundingBox();
  const viewport = page.viewportSize();
  assertBubbleGeometry(bubbleBox, retryBox, viewport);
  await page.screenshot({
    path: path.join(out, `rotation-${width}-status.png`),
    animations: "disabled",
  });
  const tray = await openTray(page);
  const message = tray.getByText(failure, { exact: true });
  const card = tray.locator("article").filter({ hasText: failure });
  await card.scrollIntoViewIfNeeded();
  const dismiss = card.getByRole("button", { name: "Dismiss", exact: true });
  await dismiss.scrollIntoViewIfNeeded();
  const notice = await message.boundingBox();
  const dismissBox = await dismiss.boundingBox();
  assert(
    notice &&
      viewport &&
      notice.y >= 0 &&
      notice.y + notice.height <= viewport.height,
    "rotation failure fits in the viewport",
  );
  assert(
    dismissBox &&
      viewport &&
      dismissBox.width >= 44 &&
      dismissBox.height >= 44 &&
      dismissBox.y >= 0 &&
      dismissBox.y + dismissBox.height <= viewport.height,
    "dismiss control is visible and touchable",
  );
  await page.screenshot({
    path: path.join(out, `rotation-${width}-failure.png`),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await tray.waitFor({ state: "hidden" });
  await verifyRotationFailureRemoved(page, width);
}

async function withPhone(width, run) {
  const { page, context } = await harness.newPage(browser, {
    device: {
      viewport: { width, height: width === 320 ? 568 : 844 },
      isMobile: true,
      hasTouch: true,
      colorScheme:
        process.env.PAGES_VERIFY_COLOR_SCHEME === "dark" ? "dark" : "light",
    },
  });
  page.setDefaultTimeout(15_000);
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin,
    });
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await run(page);
  } catch (error) {
    await page.screenshot({
      path: path.join(out, `rotation-${width}-error.png`),
      animations: "disabled",
    });
    throw error;
  } finally {
    await context.close();
  }
}

try {
  for (const width of [320, 390]) {
    await withPhone(width, async (page) => {
      await doorGuest(page).tap();
      await enableAccounts(page);
      await generateAndCopy(page);
    });
    await withPhone(width, async (page) => {
      await sealWithPin(page);
      await verifyFailureClearsOnLock(page, width);
    });
    console.log(
      `PASS ${width}px: saved guest generation and copy, rotation error clears on lock`,
    );
  }
  assert.deepEqual(harness.failures, []);
} finally {
  await browser.close();
}
console.log(`Evidence: ${out}`);
