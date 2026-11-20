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

async function profilePlanFingerprint(page, profileId) {
  if (profileId === "custom") {
    const tab = page.getByRole("tab", { selected: true });
    return `custom:${(await tab.innerText()).trim()}`;
  }
  const kinds = await page
    .locator("[id^='setup-config-']")
    .allInnerTexts()
    .catch(() => []);
  if (kinds.length > 0) {
    return `${profileId}:picker:${kinds.join("|")}`;
  }
  const title = await page
    .getByRole("heading", { level: 1 })
    .innerText()
    .catch(() => "");
  const frameVisible = await page
    .locator(".setup__frame")
    .isVisible()
    .catch(() => false);
  return `${profileId}:${title}:${frameVisible}`;
}

function roadLabel(profileId) {
  if (profileId === "minimal") return "Minimal";
  if (profileId === "default") return "Default";
  if (profileId === "custom") return "Custom";
  return "Full";
}

async function waitForPlanApplied(page, profileId, check) {
  if (profileId === "custom") {
    const tab = page.getByRole("tab", { name: /^capabilities$/i });
    await tab.waitFor({ timeout: 20_000 });
    check(await tab.isVisible(), "custom opens the capability ceremony");
    return;
  }
  await page
    .getByRole("heading", { level: 1, name: "Sign in" })
    .waitFor({ timeout: 45_000 });
  check(
    await page.getByRole("heading", { level: 1, name: "Sign in" }).isVisible(),
    `${profileId} applied and reached sign-in`,
  );
}

/** Choose a road, apply the plan (including Minimal confirm), capture proof. */
export async function captureProfilePicker(page, href, dir, profileId, check) {
  await openSetupChoices(page, href);
  await assertOnSetup(page, check);
  const choice = roadLabel(profileId);
  await page.getByRole("button", { name: choice, exact: true }).click();
  if (profileId === "minimal") {
    await page.waitForTimeout(400);
    const warning = path.join(dir, "setup-minimal-confirm-tray.png");
    const anyway = page.getByRole("button", { name: "Use Minimal anyway" });
    try {
      await page
        .getByRole("button", { name: /Notifications —/ })
        .first()
        .waitFor({ state: "visible", timeout: 8_000 });
      await page
        .getByRole("button", { name: /Notifications —/ })
        .first()
        .click();
      const dialog = page.getByRole("dialog", { name: "Notifications" });
      await dialog.waitFor({ timeout: 8_000 });
      await shotPage(page, warning);
      await dialog.getByRole("button", { name: "Use Minimal anyway" }).click();
    } catch {
      try {
        await anyway.first().waitFor({ state: "visible", timeout: 4_000 });
        await anyway.first().click();
      } catch {
        // Older main-line builds commit Minimal without the extra confirm step.
      }
    }
  }
  await waitForPlanApplied(page, profileId, check);
  const file = path.join(dir, "setup-profile-applied.png");
  if (profileId === "custom") {
    await shotFrame(page, file);
    const tab = page.getByRole("tab", { selected: true });
    const tabText = (await tab.innerText()).trim();
    check(
      /capabilities/i.test(tabText),
      `${profileId} ceremony names capabilities`,
    );
  } else {
    await shotPage(page, file);
  }
  check(
    !(await page
      .locator(".setup__frame")
      .isVisible()
      .catch(() => false)) || profileId === "custom",
    `${profileId} left the picker after apply`,
  );
  const fingerprint = await profilePlanFingerprint(page, profileId);
  return { file, fingerprint };
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

async function exitVaultLockTutorial(page, href, sealLocalOnly) {
  await openVaultDefaultPin(page, href, sealLocalOnly);
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
  sealLocalOnly,
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
      await exitVaultLockTutorial(page, href, sealLocalOnly);
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
      await exitVaultLockTutorial(page, href, sealLocalOnly);
      const dialog = await openNotes(page);
      await dialog.getByRole("button", { name: "Only this one" }).click();
      await page.waitForTimeout(500);
      check(
        (await countResumeKeys(dialog)) === 1,
        "Only this one leaves one queued tour",
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
      await exitVaultLockTutorial(page, href, sealLocalOnly);
      const dialog = await openNotes(page);
      const pauseCard = dialog.locator(".notice-card", {
        hasText: "Pause the others",
      });
      await pauseCard.getByRole("button", { name: "Dismiss" }).click();
      await page.waitForTimeout(300);
      check(
        (await countResumeKeys(dialog)) === 1,
        "dismiss (X) still leaves tour queued",
      );
      const dismissX = path.join(dir, "tutorial-pause-dismiss-x.png");
      await shotPage(page, dismissX);
    } finally {
      await context.close();
    }
  }

  {
    const { context, page } = await freshPage();
    try {
      await exitVaultLockTutorial(page, href, sealLocalOnly);
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
