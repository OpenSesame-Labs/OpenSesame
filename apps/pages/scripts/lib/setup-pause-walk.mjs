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

async function clearObstructingSheets(page) {
  const notifications = page.getByRole("dialog", { name: "Notifications" });
  if (await notifications.isVisible().catch(() => false)) {
    const close = notifications.getByRole("button", {
      name: "Close",
      exact: true,
    });
    if (await close.isVisible().catch(() => false)) await close.click();
    await notifications
      .waitFor({ state: "hidden", timeout: 5_000 })
      .catch(() => {});
  }
  const support = page.getByRole("dialog", { name: "Support", exact: true });
  if (await support.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await support.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  }
  const coach = page.locator(".coach__card").visible();
  if (await coach.isVisible().catch(() => false)) {
    const exit = page.getByRole("button", { name: "Exit tutorial" });
    if (await exit.isVisible().catch(() => false)) await exit.click();
    await coach.waitFor({ state: "hidden", timeout: 8_000 }).catch(() => {});
  }
  await page.waitForTimeout(200);
}

export async function openNotes(page) {
  await clearObstructingSheets(page);
  const dialog = page.getByRole("dialog", { name: "Notifications" });
  if (await dialog.isVisible().catch(() => false)) {
    return dialog;
  }
  await page
    .getByRole("button", { name: /Notifications —/ })
    .first()
    .click();
  await dialog.waitFor({ timeout: 8_000 });
  return dialog;
}

function rectsOverlap(a, b) {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

/** Action keys on each notice card must not sit on top of one another. */
export async function assertNoticeActionsNoOverlap(dialog, check) {
  const cards = dialog.locator(".notice-card");
  const cardCount = await cards.count();
  for (let card = 0; card < cardCount; card += 1) {
    const buttons = cards.nth(card).locator(".actions button");
    const buttonCount = await buttons.count();
    const boxes = [];
    for (let i = 0; i < buttonCount; i += 1) {
      const box = await buttons.nth(i).boundingBox();
      if (box) boxes.push(box);
    }
    for (let left = 0; left < boxes.length; left += 1) {
      for (let right = left + 1; right < boxes.length; right += 1) {
        check(
          !rectsOverlap(boxes[left], boxes[right]),
          `notice-card ${card}: action ${left} and ${right} do not overlap`,
        );
      }
    }
  }
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

async function withFreshPage(browser, freshHarnessPage, run) {
  const opened = await freshHarnessPage(browser);
  try {
    await run(opened.page);
  } finally {
    await opened.context.close();
  }
}

async function capturePauseOptOut(page, href, profileId, check, dir) {
  await exitVaultLockTutorial(page, href, profileId, check, dir);
  const dialog = await openNotes(page);
  await dialog
    .getByRole("button", { name: "Pause tutorials", exact: true })
    .first()
    .waitFor({ timeout: 8_000 });
  await dialog
    .getByRole("button", { name: "Resume walkthrough" })
    .first()
    .waitFor({ timeout: 8_000 });
  await assertNoticeActionsNoOverlap(dialog, check);
  await shotPage(page, path.join(dir, "tutorial-opt-out-notifications.png"));
  check(
    (await countResumeKeys(dialog)) === 1,
    "one queued tour before pause choice",
  );
}

async function capturePauseOnlyOne(page, href, profileId, check, dir) {
  await exitVaultLockTutorial(page, href, profileId, check, dir);
  const dialog = await openNotes(page);
  await dialog.getByRole("button", { name: "Keep tutorials on" }).click();
  await page.waitForTimeout(500);
  check(
    (await countResumeKeys(dialog)) === 1,
    "Keeping tutorials on leaves one queued tour",
  );
  check(
    (await dialog
      .getByRole("button", { name: "Pause tutorials", exact: true })
      .count()) === 0,
    "Keeping tutorials on clears the pause prompt",
  );
  const pauseOthers = dialog.locator(".notice-card", {
    hasText: "Pause tutorials for this session?",
  });
  check(
    (await pauseOthers.count()) === 0,
    "Keeping tutorials on removes the pause card",
  );
  await assertNoticeActionsNoOverlap(dialog, check);
  await shotPage(page, path.join(dir, "tutorial-pause-only-one.png"));
}

async function capturePauseDismissX(page, href, profileId, check, dir) {
  await exitVaultLockTutorial(page, href, profileId, check, dir);
  let dialog = await openNotes(page);
  const pauseCard = dialog.locator(".notice-card", {
    hasText: "Pause tutorials for this session?",
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
  dialog = await openNotes(page);
  await assertNoticeActionsNoOverlap(dialog, check);
  await shotPage(page, path.join(dir, "tutorial-pause-dismiss-x.png"));
  dialog = await openNotes(page);
  check(
    (await countResumeKeys(dialog)) === 1,
    "dismiss (X) still leaves tour queued after closing tray",
  );
}

async function capturePauseAllReload(page, href, profileId, check, dir) {
  await exitVaultLockTutorial(page, href, profileId, check, dir);
  let dialog = await openNotes(page);
  await dialog
    .getByRole("button", { name: "Pause tutorials", exact: true })
    .click();
  await page.waitForTimeout(1200);
  const pauseAllCount = await countResumeKeys(dialog);
  check(
    pauseAllCount > 1,
    `pause all queues more than the declined tour (${pauseAllCount})`,
  );
  check(
    pauseAllCount <= TUTORIAL_QUEUE_LIMIT,
    `pause all respects cap (${pauseAllCount})`,
  );
  await assertNoticeActionsNoOverlap(dialog, check);
  await shotPage(page, path.join(dir, "tutorial-pause-all-queued.png"));
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForTimeout(2500);

  await page.reload({ waitUntil: "domcontentloaded" });
  // Exact name skips "Unlock vault". `.visible()` on both keeps a hidden
  // control earlier in the DOM from winning this wait over the shown one.
  const lock = page
    .getByRole("button", { name: "Lock vault", exact: true })
    .visible();
  const pin = page.getByLabel("PIN", { exact: true }).visible();
  await lock.or(pin).first().waitFor({ state: "visible", timeout: 30_000 });
  if (await pin.isVisible().catch(() => false)) await unlockWithPin(page);
  dialog = await openNotes(page);
  let afterReload = await countResumeKeys(dialog);
  const deadline = Date.now() + 30_000;
  while (afterReload < pauseAllCount && Date.now() < deadline) {
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    if (await close.isVisible().catch(() => false)) await close.click();
    await page.waitForTimeout(800);
    dialog = await openNotes(page);
    afterReload = await countResumeKeys(dialog);
  }
  check(
    afterReload === pauseAllCount,
    `queued tours survive reload (${afterReload} of ${pauseAllCount})`,
  );
  await assertNoticeActionsNoOverlap(dialog, check);
  await shotPage(page, path.join(dir, "tutorial-queue-after-reload.png"));
  const pauseLeft = await dialog
    .getByRole("button", { name: "Pause tutorials", exact: true })
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
  await shotPage(page, path.join(dir, "tutorial-resumed-coach.png"));
}

export async function captureTutorialPauseFlow(
  browser,
  freshHarnessPage,
  dir,
  check,
  href,
  profileId,
) {
  check(mergedGuideGoalCount() > 1, "merged guide goals");
  await withFreshPage(browser, freshHarnessPage, (page) =>
    capturePauseOptOut(page, href, profileId, check, dir),
  );
  await withFreshPage(browser, freshHarnessPage, (page) =>
    capturePauseOnlyOne(page, href, profileId, check, dir),
  );
  await withFreshPage(browser, freshHarnessPage, (page) =>
    capturePauseDismissX(page, href, profileId, check, dir),
  );
  await withFreshPage(browser, freshHarnessPage, (page) =>
    capturePauseAllReload(page, href, profileId, check, dir),
  );
}
