#!/usr/bin/env node
/** Check password generation and rotation feedback on a real mobile viewport. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { doorGuest } from "./lib/front-door.mjs";
import {
  PIN,
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
const side = process.env.EVIDENCE_SIDE;
assert(["before", "after"].includes(side));
const failure = side === "after"
  ? "Rotation is queued and may retry. Its status could not be confirmed."
  : "The rotation could not be queued.";
const measurements = [];
const touch = (page) => page.viewportSize().width !== 1280;
const press = (page, locator) => touch(page) ? locator.tap() : locator.click();
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

// Close transient first-visit prompts through their real controls on both builds.
// This keeps unrelated prompts from obscuring one side of the comparison.
async function dismissAmbientPrompts(page) {
  const offer = page.locator('aside[aria-label$=" walkthrough"]')
    .getByRole("button", {name: "Not now", exact: true});
  const dismiss = page.getByRole("button", {name: /^Dismiss recommendation:/});
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.waitForTimeout(350);
    const hasOffer = await offer.count() && await offer.first().isVisible();
    const hasRecommendation = await dismiss.count() && await dismiss.first().isVisible();
    if (hasOffer) await press(page, offer.first());
    if (hasRecommendation) await press(page, dismiss.first());
    if (!hasOffer && !hasRecommendation) {
      await page.waitForTimeout(350);
      if (!(await offer.count() && await offer.first().isVisible()) &&
          !(await dismiss.count() && await dismiss.first().isVisible())) return;
    }
  }
  throw new Error("Ambient prompts did not settle");
}

async function generateAndCopy(page) {
  const name = "Guest mail";
  await newAccount(page, name, "https://mail.example.test");
  await dismissAmbientPrompts(page);
  const generatorRegion = page.getByRole("region", { name: /^(Password generator|Rotation)$/ });
  if (await generatorRegion.count()) await generatorRegion.first().scrollIntoViewIfNeeded();
  await page.screenshot({path: path.join(out, `guest-${page.viewportSize().width}-detail.png`), animations: "disabled"});
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  await dismissAmbientPrompts(page);
  const password = page.getByLabel("Password", { exact: true }).first();
  const before = await password.inputValue();
  const generate = page.getByRole("button", { name: "Generate another password" });
  await generate.scrollIntoViewIfNeeded();
  measurements.push({width: page.viewportSize().width, stage: "guest-editor", control: await generate.boundingBox()});
  await page.screenshot({path: path.join(out, `guest-${page.viewportSize().width}-editor.png`), animations: "disabled"});
  await press(page, generate);
  const generated = await password.inputValue();
  assert(
    generated && generated !== before,
    "editor generates a new local password",
  );
  await page.getByRole("button", { name: "Save item" }).click();
  await page.getByRole("heading", { level: 1, name }).waitFor();
  await press(page, page.getByRole("button", { name: "Copy password", exact: true }));
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    generated,
  );
}

async function openTray(page) {
  await press(page, page
    .getByRole("button", { name: /^Notifications/ })
    .filter({ visible: true })
    .first());
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

async function verifyFailureClearsOnLock(page, width) {
  await prepareFailingRotation(page);
  await dismissAmbientPrompts(page);
  const panel = page.getByRole("region", { name: "Rotation", exact: true });
  const action = panel.getByRole("button", { name: "Request rotation" });
  await action.scrollIntoViewIfNeeded();
  const beforeAction = await action.boundingBox();
  await press(page, action);

  // Both revisions see the same real request and simulated storage failure.
  // Wait for the tray's exact error before comparing either visible surface.
  let tray = await openTray(page);
  const message = tray.getByText(failure, { exact: true });
  await message.waitFor({ state: "visible" });
  const card = tray.locator("article").filter({ hasText: failure });
  const dismiss = card.getByRole("button", { name: "Dismiss", exact: true });
  await dismiss.scrollIntoViewIfNeeded();
  const notice = await message.boundingBox();
  const dismissBox = await dismiss.boundingBox();
  await page.screenshot({path: path.join(out, `rotation-${width}-failure.png`), animations: "disabled"});
  await page.keyboard.press("Escape");
  await tray.waitFor({state: "hidden"});
  await dismissAmbientPrompts(page);
  await action.scrollIntoViewIfNeeded();
  const status = panel.getByRole("img", {name: failure});
  const statusCount = await status.count();
  const statusBox = statusCount ? await status.boundingBox() : null;
  const actionBox = await action.boundingBox();
  const record = {width, viewport: page.viewportSize(), side, failure,
    beforeAction, action: actionBox, status: statusBox, statusCount,
    notice, dismiss: dismissBox, panelText: await panel.innerText()};
  await page.screenshot({path: path.join(out, `rotation-${width}-error.png`), animations: "disabled"});
  if (side === "after") {
    assert.equal(statusCount, 1, "the failure is visible beside the action");
    if (touch(page)) {
      assert(actionBox && actionBox.width >= 44 && actionBox.height >= 44);
      assert(statusBox && statusBox.width >= 44 && statusBox.height >= 44);
      assert(statusBox.x + statusBox.width <= actionBox.x);
      await press(page, status);
      const bubble = page.locator(".status-bubble").filter({hasText: failure});
      await bubble.waitFor();
      const bubbleBox = await bubble.boundingBox();
      const retryBox = await action.boundingBox();
      assertBubbleGeometry(bubbleBox, retryBox, page.viewportSize());
      record.bubble = bubbleBox;
      record.actionWithBubble = retryBox;
      await page.screenshot({path: path.join(out, `rotation-${width}-status.png`), animations: "disabled"});
    }
  } else {
    assert.equal(statusCount, 0, "the baseline has no inline status");
  }
  await restoreRotationStorage(page);
  await lockVault(page);
  await page.screenshot({path: path.join(out, `unlock-${width}-locked.png`), animations: "disabled"});
  await page.getByLabel("PIN", { exact: true }).fill(PIN);
  const unlock = page.getByRole("button", { name: "Unlock", exact: true });
  const unlockBox = await unlock.boundingBox();
  const unlockHit = unlockBox && await unlock.evaluate((node, point) => {
    const top = document.elementFromPoint(point.x, point.y);
    return top === node || node.contains(top);
  }, { x: unlockBox.x + unlockBox.width / 2, y: unlockBox.y + unlockBox.height / 2 });
  record.unlock = { box: unlockBox, hit: Boolean(unlockHit) };
  await page.screenshot({path: path.join(out, `unlock-${width}-ready.png`), animations: "disabled"});
  if (side === "after" && touch(page)) {
    assert(unlockBox && unlockBox.x >= 0 && unlockBox.y >= 0 &&
      unlockBox.x + unlockBox.width <= page.viewportSize().width &&
      unlockBox.y + unlockBox.height <= page.viewportSize().height &&
      unlockBox.width >= 44 && unlockBox.height >= 44 && unlockHit,
      "existing-vault Unlock control is visible and reachable");
  }
  await unlockWithPin(page);
  await dismissAmbientPrompts(page);
  tray = await openTray(page);
  record.failureAfterUnlock = await tray.getByText(failure, {exact: true}).count();
  await page.screenshot({path: path.join(out, `rotation-${width}-after-lock.png`), animations: "disabled"});
  if (side === "after") assert.equal(record.failureAfterUnlock, 0);
  measurements.push(record);
  fs.writeFileSync(path.join(out, "measurements.json"), JSON.stringify(measurements, null, 2) + "\n");
  console.log(`MEASURE ${JSON.stringify(record)}`);
}

async function withPhone(width, run) {
  const { page, context } = await harness.newPage(browser, {
    device: {
      viewport: { width, height: width === 320 ? 568 : width === 390 ? 844 : 900 },
      isMobile: width !== 1280,
      hasTouch: width !== 1280,
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
      path: path.join(out, `rotation-${width}-diagnostic.png`),
      animations: "disabled",
    }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

try {
  for (const width of (process.env.EVIDENCE_WIDTHS ?? "320,390,1280").split(",").map(Number)) {
    await withPhone(width, async (page) => {
      await press(page, doorGuest(page));
      await enableAccounts(page);
      await generateAndCopy(page);
    });
    await withPhone(width, async (page) => {
      await sealWithPin(page);
      await verifyFailureClearsOnLock(page, width);
    });
    console.log(
      `PASS ${side} ${width}px: saved guest generation and copy, rotation failure captured`,
    );
  }
  assert.deepEqual(harness.failures, []);
} finally {
  await browser.close();
}
console.log(`Evidence: ${out}`);
