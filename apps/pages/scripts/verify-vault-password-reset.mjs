#!/usr/bin/env node
/**
 * Vault password-reset handoff against the built static PWA.
 *
 * Path 1 (not configured): a locally sealed vault with no `ai.password-reset`
 * approval. The rotation action prompts through the bell tray with a Settings
 * action, while the editor generates a new password locally.
 *
 * Path 2 (configured): following the notice's Settings action and turning
 * Password reset on routes the same key through the installed readiness
 * seam; the tray asks for whichever prerequisite is missing. A deployment
 * may already provide an anonymous computer-use runtime, in which case it
 * asks for a model instead. The queued/in-progress state with readiness ok
 * needs the seam double and is covered by RotationPanel.test.tsx; no
 * in-page stub can install a module seam without a test-only hook.
 *
 * No loopback API is called: the static origin harness serves dist/ and
 * every assertion is on DOM the person would see.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  addCapabilities,
  openSettingsCategory,
  sealWithPin,
} from "./lib/pages-journey.mjs";
import { privateTempDir } from "./lib/private-files.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const origin = "https://opensesame-labs.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const out =
  process.env.PAGES_VERIFY_OUT ??
  privateTempDir("opensesame-vault-password-reset-");
fs.mkdirSync(out, { recursive: true });
console.log(`Evidence: ${out}`);
const harness = createHarness({
  dist:
    process.env.EVIDENCE_DIST ?? path.resolve(import.meta.dirname, "../dist"),
  origin,
  base,
  out,
});
const browser = await harness.launch({
  args: process.env.PLAYWRIGHT_NO_SANDBOX
    ? ["--no-sandbox", "--disable-dev-shm-usage"]
    : [],
});

async function openTray(page) {
  const bell = page
    .getByRole("button", { name: /^Notifications/ })
    .locator("visible=true")
    .first();
  await bell.waitFor({ timeout: 15000 });
  await bell.click();
  const tray = page.getByRole("dialog", { name: "Notifications" });
  await tray.waitFor({ timeout: 15000 });
  return tray;
}

async function closeTray(page) {
  await page.keyboard.press("Escape");
  await page
    .getByRole("dialog", { name: "Notifications" })
    .waitFor({ state: "detached", timeout: 15000 });
}

try {
  const { page, context } = await harness.newPage(browser, {
    device: { viewport: { width: 1280, height: 900 } },
  });
  await page.goto(`${origin}${base}`);
  await sealWithPin(page);

  // An account with an https site and a generated password.
  await openSettingsCategory(page, "Item types");
  const accountSwitch = page.getByRole("switch", {
    name: "Account",
    exact: true,
  });
  if ((await accountSwitch.getAttribute("aria-checked")) === "false")
    await accountSwitch.click();
  await page.waitForFunction(() => {
    const found = document.querySelector(
      '[role="switch"][aria-label="Account"]',
    );
    return (
      found?.getAttribute("aria-checked") === "true" &&
      found?.getAttribute("aria-busy") !== "true"
    );
  });
  await page.evaluate(
    (route) => {
      history.pushState(null, "", route);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    `${base}vault/new/account?uri=${encodeURIComponent("https://mail.example.test")}`,
  );
  await page
    .getByLabel("Name", { exact: true })
    .first()
    .fill("Reset Walk Account");
  await page.getByRole("button", { name: "Save item" }).first().click();
  await page.waitForURL((url) => /\/vault\/[^/]+$/.test(url.pathname));
  const itemUrl = page.url();

  // Path 1a: the rotation panel prompts to configure.
  const rotation = page.getByRole("region", { name: "Rotation" });
  await rotation.waitFor({ timeout: 15000 });
  await rotation
    .getByRole("button", { name: /Request password rotation/ })
    .click();
  let tray = await openTray(page);
  await tray.getByText("Password reset", { exact: true }).first().waitFor();
  await tray.getByText(/Turn on Password reset/).waitFor();
  assert.equal(
    await tray.getByRole("button", { name: "Settings" }).count(),
    1,
    "the not-configured notice carries a Settings action",
  );
  await closeTray(page);

  // Path 1b: the editor generates locally without starting a provider reset.
  await page.evaluate(
    (route) => {
      history.pushState(null, "", route);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    `${new URL(itemUrl).pathname}/edit`,
  );
  const password = page.getByLabel("Password", { exact: true });
  await password.waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Show password" }).click();
  const before = await password.inputValue();
  await page.getByRole("button", { name: "Generate another password" }).click();
  const generated = await password.inputValue();
  assert(
    generated.length > 0 && generated !== before,
    "the editor generates a new local password",
  );

  // Path 2: turn the feature on the way a person does, then the same key
  // reaches readiness and names the missing prerequisite. The switch is on when
  // the plan commits; the readiness seam is installed when the module leaves
  // "starting". A document load would lock this vault, so the item is
  // opened in place, the way the other walks move.
  await addCapabilities(page, ["Password reset"]);
  await page.waitForFunction(() => {
    const found = document.querySelector(
      '[role="switch"][data-capability-title="Password reset"]',
    );
    return (
      found?.getAttribute("aria-checked") === "true" &&
      found?.getAttribute("aria-busy") !== "true"
    );
  });
  const starting = page
    .locator("#feature-password-reset")
    .getByRole("img", { name: "starting", exact: true });
  if ((await starting.count()) === 0) {
    await starting.waitFor({ state: "visible", timeout: 1000 }).catch(() => {});
  }
  await starting.waitFor({ state: "hidden", timeout: 15000 });
  const item = new URL(itemUrl);
  await page.evaluate((route) => {
    history.pushState(null, "", route);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `${item.pathname}${item.search}${item.hash}`);
  const rotationAgain = page.getByRole("region", { name: "Rotation" });
  await rotationAgain.waitFor({ timeout: 15000 });
  await rotationAgain
    .getByRole("button", { name: /Request password rotation/ })
    .click();
  tray = await openTray(page);
  const needsRuntime = tray.getByText(
    /^Connect a computer-use runtime under Settings/,
  );
  const needsModel = tray.getByText(
    /^Choose a model for password reset under Settings/,
  );
  await needsRuntime.or(needsModel).first().waitFor();
  const expectedDestination = (await needsRuntime.isVisible())
    ? "/settings/integrations#integration-password-reset"
    : "/settings/features#feature-ai";
  await tray.getByRole("button", { name: "Settings", exact: true }).click();
  await page.waitForURL((url) =>
    `${url.pathname}${url.hash}`.endsWith(expectedDestination),
  );

  assert.deepEqual(harness.failures, []);
  await context.close();
  console.log(
    "Vault password-reset setup, local generation, and runtime readiness prompts passed.",
  );
} finally {
  await browser.close();
}
