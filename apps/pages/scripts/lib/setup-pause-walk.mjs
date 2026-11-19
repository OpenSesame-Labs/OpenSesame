/**
 * Browser steps for setup roads and the tutorial pause queue. Screenshots
 * clip to `.setup__frame` so the door header does not dominate profile shots.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { unlockWithPin } from "./pages-journey.mjs";
import { startTutorial, tutorialDialog } from "./tutorial-walk.mjs";

export async function openSetupChoices(page, href) {
  await page.goto(href, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "Set up your own", exact: true })
    .click();
  const frame = page.locator(".setup__frame");
  await frame.waitFor({ timeout: 20_000 });
  await page
    .getByRole("button", { name: "Default", exact: true })
    .waitFor({ timeout: 15_000 });
  return frame;
}

export async function shotFrame(page, file) {
  const frame = page.locator(".setup__frame");
  await frame.waitFor({ timeout: 15_000 });
  await page.waitForTimeout(350);
  await frame.screenshot({ path: file, animations: "disabled" });
  return frame;
}

export async function shotPage(page, file) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: file, animations: "disabled" });
}

export async function assertOnSetup(page, check) {
  const frame = page.locator(".setup__frame");
  const setup = await frame.isVisible().catch(() => false);
  check(setup, "setup frame is visible");
  const signIn = await page
    .getByRole("heading", { level: 1, name: "Sign in" })
    .isVisible()
    .catch(() => false);
  check(!signIn, "not on sign-in during setup capture");
}

export async function assertRoads(page, check, expectAdvanced) {
  const defaultKind = (
    await page.locator("#setup-config-default").innerText()
  ).trim();
  const minimalKind = (
    await page.locator("#setup-config-minimal").innerText()
  ).trim();
  const lead = page.getByRole("button", { name: "Default", exact: true });
  const minimal = page.getByRole("button", { name: "Minimal", exact: true });
  const leadClass = (await lead.getAttribute("class")) ?? "";
  const minimalClass = (await minimal.getAttribute("class")) ?? "";
  if (expectAdvanced) {
    check(defaultKind.startsWith("Recommended."), `Default kind: ${defaultKind}`);
    check(leadClass.includes("road--lead"), "Default is the lead road");
    check(minimalKind.startsWith("Advanced."), `Minimal kind: ${minimalKind}`);
    check(minimalClass.includes("road--advanced"), "Minimal is the advanced road");
  } else {
    check(
      !minimalKind.startsWith("Advanced."),
      `main minimal kind not advanced: ${minimalKind}`,
    );
  }
  const panelBody = await page.locator(".setup__body").innerText();
  check(
    !/Use Minimal anyway/.test(panelBody),
    "minimal confirm is not in the setup panel",
  );
}

export function profileDir(root, build, profileId) {
  const dir = path.join(root, build, profileId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function captureProfilePicker(page, href, dir, profileId, check) {
  await openSetupChoices(page, href);
  await assertOnSetup(page, check);
  const choice =
    profileId === "minimal"
      ? "Minimal"
      : profileId === "default"
        ? "Default"
        : profileId === "custom"
          ? "Custom"
          : "Full";
  await page.getByRole("button", { name: choice, exact: true }).focus();
  const file = path.join(dir, "setup-profile-picker.png");
  await shotFrame(page, file);
  check(
    (await page.locator(".setup__frame").innerText()).includes(profileId),
    `${profileId} picker names the profile`,
  );
  return file;
}

export async function captureMinimalWarning(page, dir, check) {
  await openSetupChoices(page, page.url());
  await page.getByRole("button", { name: "Minimal", exact: true }).click();
  await page
    .getByRole("button", { name: /Notifications —/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Notifications" });
  await dialog.waitFor({ timeout: 8_000 });
  check(
    (await dialog.innerText()).includes("Advanced."),
    "minimal warning in notifications tray",
  );
  const trayShot = path.join(dir, "minimal-warning-notifications.png");
  await shotPage(page, trayShot);
  const notice = dialog.getByRole("button", { name: "Use Minimal anyway" });
  check((await notice.count()) > 0, "Use Minimal anyway in tray");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}

export async function openNotes(page) {
  await page
    .getByRole("button", { name: /Notifications —/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Notifications" });
  await dialog.waitFor({ timeout: 8_000 });
  return dialog;
}

export async function openVaultDefaultPin(page, href, sealLocalOnly) {
  await page.goto(href, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "Set up your own", exact: true })
    .click();
  await page.getByRole("button", { name: "Default", exact: true }).click();
  await page
    .getByRole("heading", { level: 1, name: "Sign in" })
    .waitFor({ timeout: 30_000 });
  await sealLocalOnly(page);
}

export async function captureTutorialPauseFlow(
  page,
  dir,
  check,
  href,
  sealLocalOnly,
) {
  await openVaultDefaultPin(page, href, sealLocalOnly);
  await startTutorial(page, "vault.lock");
  await page.getByRole("button", { name: "Exit tutorial" }).click();
  const queued = await openNotes(page);
  await queued
    .getByRole("button", { name: "Pause all for this session" })
    .first()
    .waitFor({ timeout: 8_000 });
  await queued
    .getByRole("button", { name: "Resume walkthrough" })
    .first()
    .waitFor({ timeout: 8_000 });
  const optOut = path.join(dir, "tutorial-opt-out-notifications.png");
  await shotPage(page, optOut);
  const lockCard = queued.locator(".notice-card", {
    hasText: "Lock the vault",
  });
  await lockCard.getByRole("button", { name: "Resume walkthrough" }).waitFor();
  await queued
    .getByRole("button", { name: "Pause all for this session" })
    .click();
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "domcontentloaded" });
  const lock = page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true");
  const pin = page.getByLabel("PIN", { exact: true });
  await lock.or(pin).first().waitFor({ timeout: 30_000 });
  if (await pin.isVisible().catch(() => false)) await unlockWithPin(page);
  const again = await openNotes(page);
  const restored = again.locator(".notice-card", { hasText: "Lock the vault" });
  await restored.getByRole("button", { name: "Resume walkthrough" }).waitFor();
  const reloaded = path.join(dir, "tutorial-queue-after-reload.png");
  await shotPage(page, reloaded);
  const pauseLeft = await again
    .getByRole("button", { name: "Pause all for this session" })
    .count();
  check(pauseLeft === 0, "pause prompt is gone after reload");
  await restored.getByRole("button", { name: "Resume walkthrough" }).click();
  await tutorialDialog(page).waitFor({ timeout: 20_000 });
  const resumed = path.join(dir, "tutorial-resumed-coach.png");
  await shotPage(page, resumed);
}