/**
 * Browser steps for setup roads and the tutorial pause queue. Screenshots
 * clip to `.setup__frame` so the door header does not dominate profile shots.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { unlockWithPin } from "./pages-journey.mjs";
import {
  TUTORIAL_QUEUE_LIMIT,
  mergedGuideGoalCount,
} from "./setup-pause-goals.mjs";
import {
  applySetupProfileToUnlockedVault,
  captureProfileAppliedVault,
  profileMarkerKey,
} from "./setup-profile-vault.mjs";
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
    check(
      defaultKind.startsWith("Recommended."),
      `Default kind: ${defaultKind}`,
    );
    check(leadClass.includes("road--lead"), "Default is the lead road");
    check(minimalKind.startsWith("Advanced."), `Minimal kind: ${minimalKind}`);
    check(
      minimalClass.includes("road--advanced"),
      "Minimal is the advanced road",
    );
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

/** Choose a road, seal vault, assert profile DOM, capture unlocked vault. */
export async function captureProfilePicker(page, href, dir, profileId, check) {
  const result = await captureProfileAppliedVault(
    page,
    href,
    dir,
    profileId,
    check,
  );
  const setupVisible = await page
    .locator(".setup__frame")
    .isVisible()
    .catch(() => false);
  check(!setupVisible, `${profileId} left setup on unlocked vault`);
  return {
    file: result.file,
    features: result.features,
    picker: result.picker,
    markers: result.markers,
    markerKey: profileMarkerKey(result.markers),
  };
}

export async function captureMinimalWarning(page, dir, check, href) {
  await openSetupChoices(page, href);
  await page.getByRole("button", { name: "Minimal", exact: true }).click();
  await page
    .getByRole("button", { name: /Notifications —/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Notifications" });
  await dialog.waitFor({ timeout: 8_000 });
  const trayText = await dialog.innerText();
  check(
    /password|passkey|card|note/.test(trayText),
    "minimal warning names what Minimal gives up",
  );
  check(
    (await dialog.getByRole("button", { name: "Keep Default" }).count()) > 0,
    "Keep Default in tray",
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

async function exitVaultLockTutorial(page, href, profileId, check, dir) {
  await applySetupProfileToUnlockedVault(page, href, profileId, check, dir);
  const card = await startTutorial(page, "vault.lock");
  await card.getByRole("button", { name: "Exit tutorial" }).click();
  await card.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

async function countResumeKeys(dialog) {
  return dialog.getByRole("button", { name: "Resume walkthrough" }).count();
}

export async function captureTutorialPauseFlow(
  browser,
  freshHarnessPage,
  dir,
  check,
  href,
  profileId,
) {
  let pauseAllCount;
  check(mergedGuideGoalCount() > 1, "merged guide goals");

  async function freshPage() {
    const opened = await freshHarnessPage(browser);
    return { context: opened.context, page: opened.page };
  }

  {
    const { context, page } = await freshPage();
    try {
      await exitVaultLockTutorial(page, href, profileId, check, dir);
      const dialog = await openNotes(page);
      await dialog
        .getByRole("button", { name: "Pause all for this session" })
        .first()
        .waitFor({ timeout: 8_000 });
      await dialog
        .getByRole("button", { name: "Resume walkthrough" })
        .first()
        .waitFor({ timeout: 8_000 });
      const optOut = path.join(dir, "tutorial-opt-out-notifications.png");
      await shotPage(page, optOut);
      check(
        (await countResumeKeys(dialog)) === 1,
        "one queued tour before pause choice",
      );
    } finally {
      await context.close();
    }
  }

  {
    const { context, page } = await freshPage();
    try {
      await exitVaultLockTutorial(page, href, profileId, check, dir);
      const dialog = await openNotes(page);
      await dialog.getByRole("button", { name: "Only this one" }).click();
      await page.waitForTimeout(500);
      check(
        (await countResumeKeys(dialog)) === 1,
        "Only this one leaves one queued tour",
      );
      check(
        (await dialog
          .getByRole("button", { name: "Pause all for this session" })
          .count()) === 0,
        "Only this one clears tray pause prompt",
      );
      const pauseOthers = dialog.locator(".notice-card", {
        hasText: "Pause the others",
      });
      check(
        (await pauseOthers.count()) === 0,
        "Only this one removes pause-others card",
      );
      const onlyOne = path.join(dir, "tutorial-pause-only-one.png");
      await shotPage(page, onlyOne);
    } finally {
      await context.close();
    }
  }

  {
    const { context, page } = await freshPage();
    try {
      await exitVaultLockTutorial(page, href, profileId, check, dir);
      const dialog = await openNotes(page);
      const pauseCard = dialog.locator(".notice-card", {
        hasText: "Pause the others",
      });
      await pauseCard.getByRole("button", { name: "Dismiss" }).click();
      await page.waitForTimeout(400);
      check(
        (await countResumeKeys(dialog)) === 1,
        "dismiss (X) still leaves tour queued",
      );
      check(
        (await pauseCard.isVisible().catch(() => false)) === false,
        "dismiss (X) removes tray pause card",
      );
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await page.waitForTimeout(400);
      const dismissX = path.join(dir, "tutorial-pause-dismiss-x.png");
      await shotPage(page, dismissX);
      check(
        (await countResumeKeys(await openNotes(page))) === 1,
        "dismiss (X) still leaves tour queued after closing tray",
      );
    } finally {
      await context.close();
    }
  }

  {
    const { context, page } = await freshPage();
    try {
      await exitVaultLockTutorial(page, href, profileId, check, dir);
      let dialog = await openNotes(page);
      await dialog
        .getByRole("button", { name: "Pause all for this session" })
        .click();
      await page.waitForTimeout(1200);
      const queuedCount = await countResumeKeys(dialog);
      pauseAllCount = queuedCount;
      check(
        queuedCount > 1,
        `pause all queues more than the declined tour (${queuedCount})`,
      );
      check(
        queuedCount <= TUTORIAL_QUEUE_LIMIT,
        `pause all respects cap (${queuedCount})`,
      );
      const pauseAll = path.join(dir, "tutorial-pause-all-queued.png");
      await shotPage(page, pauseAll);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await page.waitForTimeout(2500);

      await page.reload({ waitUntil: "domcontentloaded" });
      const pin = page.getByLabel("PIN", { exact: true });
      const lock = page
        .getByRole("button", { name: "Lock vault" })
        .locator("visible=true");
      await lock.or(pin).first().waitFor({ timeout: 30_000 });
      if (await pin.isVisible().catch(() => false)) await unlockWithPin(page);
      dialog = await openNotes(page);
      let afterReload = await countResumeKeys(dialog);
      const deadline = Date.now() + 30_000;
      while (afterReload < pauseAllCount && Date.now() < deadline) {
        const close = dialog.getByRole("button", {
          name: "Close",
          exact: true,
        });
        if (await close.isVisible().catch(() => false)) await close.click();
        await page.waitForTimeout(800);
        dialog = await openNotes(page);
        afterReload = await countResumeKeys(dialog);
      }
      check(
        afterReload === pauseAllCount,
        `queued tours survive reload (${afterReload} of ${pauseAllCount})`,
      );
      const reloaded = path.join(dir, "tutorial-queue-after-reload.png");
      await shotPage(page, reloaded);
      const pauseLeft = await dialog
        .getByRole("button", { name: "Pause all for this session" })
        .count();
      check(pauseLeft === 0, "pause prompt is gone after reload");
      const lockCard = dialog.locator(".notice-card", {
        hasText: "Lock the vault",
      });
      const lockResume = lockCard.getByRole("button", {
        name: "Resume walkthrough",
      });
      await lockResume.scrollIntoViewIfNeeded();
      await lockResume.click();
      await tutorialDialog(page).waitFor({ timeout: 20_000 });
      const resumed = path.join(dir, "tutorial-resumed-coach.png");
      await shotPage(page, resumed);
    } finally {
      await context.close();
    }
  }
}
