import {
  enterEnrollmentCode,
  finishUnlockWithCode,
  readSeed,
  withdrawSelfAuthenticator,
} from "./auth-flow-enroll.mjs";
import { lock } from "./auth-flow-nav.mjs";
import { passTheDoor } from "./front-door.mjs";
import { PIN as FIRST_VAULT_PIN, waitOpen } from "./pages-journey.mjs";
import { checkLateSealScroll } from "./tutorial-gates.mjs";
import { checkKeyboardViewport } from "./tutorial-keyboard-viewport.mjs";
import {
  checkControlReachable,
  checkTutorialNextBlocked,
  waitForPinTutorial,
} from "./tutorial-measure.mjs";

/** Journey 2: a PIN-sealed vault enrolls MFA directly. */
export async function pinMfaJourney({
  browser,
  newPage,
  check,
  snap,
  goSecurity,
  setStep,
  PIN,
  ORIGIN,
  BASE,
  text,
  totp,
}) {
  const { page, context } = await newPage(browser);
  setStep("2-pin");
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await passTheDoor(page);
  await page.getByRole("button", { name: "Use without an account" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("tab", { name: "PIN" }).click();
  await page.getByLabel("Device PIN", { exact: true }).fill(PIN);
  await page.getByLabel("Confirm PIN", { exact: true }).fill(PIN);
  await page
    .getByLabel("I understand this vault cannot be recovered.", { exact: true })
    .check();
  await page.getByRole("button", { name: "Seal with PIN" }).click();
  await waitOpen(page);
  check(
    await page.locator(".vault").isVisible(),
    "sealed device landed inside the app",
  );
  await goSecurity(page);
  await page
    .locator(".sw--method", { hasText: "Authenticator app" })
    .getByRole("button", { name: "Add" })
    .click();
  await page.waitForTimeout(2500);
  const dialog = page.getByRole("dialog");
  await snap(page, "2-pin-scan");
  check(
    (await dialog.locator(".steps__seg.is-now .steps__label").textContent()) ===
      "1 · Scan",
    "straight to Scan — no key step for a vault that has one",
  );
  const steps = await dialog.locator(".steps__label").allTextContents();
  check(
    steps.length === 2 &&
      /2 · Confirm/.test(steps.join(" ")) &&
      !steps.some((label) => /Key/.test(label)),
    "two steps, no key step",
  );
  const secret = await readSeed(page, check);
  await dialog.getByRole("button", { name: "I scanned it" }).click();
  await page.waitForTimeout(300);
  await enterEnrollmentCode(page, totp(secret));
  await page.waitForTimeout(1500);
  check(/Authenticator on/.test(await text(page)), "authenticator on");
  await dialog.getByRole("button", { name: "I saved them" }).click();
  await page.waitForTimeout(500);
  await withdrawSelfAuthenticator(page, check);
  await lock(page);
  const locked = await snap(page, "2-pin-locked");
  check(
    (await page.getByRole("tab", { name: "PIN" }).count()) === 1 &&
      (await page.getByRole("tab", { name: "Password" }).count()) === 0,
    "only the PIN tab is offered",
  );
  check(/2 · Authenticator code/.test(locked), "step 2 announced");
  await page.getByLabel("PIN", { exact: true }).fill(PIN);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.waitForTimeout(5000);
  await finishUnlockWithCode(page, secret, "2-pin", {
    check,
    snap,
    totp,
  });
  await context.close();
}

/** Walk the PIN-only first-vault seal after the method decision. */
export async function sealPinFirstVault(
  page,
  { step, check, phone, protection, label, out, width, keepShots },
) {
  const recovery = page.getByLabel(
    "I understand this vault cannot be recovered.",
  );
  const next = page.locator(".coach__btn--go");
  check(
    (await page.getByRole("tab", { name: "Passkey" }).count()) === 0,
    "PIN-only first vault: unavailable Passkey is not offered",
  );
  check(
    (await page
      .getByRole("tab", { name: "PIN", exact: true })
      .getAttribute("aria-selected")) === "true",
    "PIN-only first vault: PIN is selected",
  );
  await recovery.check();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent?.trim() === "PIN",
  );
  await page
    .locator('[data-guide-targets~="unlock.seal-pin-entry"]')
    .waitFor({ state: "visible" });
  check(
    (await page
      .getByText(
        "This device's passkey cannot seal a vault. Security key is selected.",
        { exact: true },
      )
      .count()) === 0,
    "first vault: PIN selection clears the stale passkey notice",
  );
  if (
    (await page
      .locator('.coach[data-coach-target="unlock.seal-actions"]')
      .count()) === 1
  ) {
    check(
      await page
        .getByText("PIN is selected. Select Next.", { exact: true })
        .isVisible(),
      "first vault: an already-mounted PIN has an accurate Next instruction",
    );
    await checkControlReachable(
      page,
      check,
      next,
      `${protection} tutorial Next`,
    );
    check(
      (await next.getAttribute("aria-disabled")) !== "true",
      "first vault: held PIN tutorial Next is enabled",
    );
    await next.click();
  }
  await walkPinFields(page, {
    step,
    check,
    phone,
    protection,
    label,
    out,
    width,
    keepShots,
  });
}

async function walkPinFields(
  page,
  { step, check, phone, protection, label, out, width, keepShots },
) {
  const recovery = page.getByLabel(
    "I understand this vault cannot be recovered.",
  );
  const next = page.locator(".coach__btn--go");
  await waitForPinTutorial(page, { out, width, label, keepShots });
  await step("unlock.seal-pin-entry", 5, 16);
  if (process.env.TUTORIALS_PIN_BACK === "1") {
    await checkTutorialNextBlocked(page, check, next, "unlock.seal-pin-entry");
    check(
      await page.getByRole("button", { name: "Seal with PIN" }).isDisabled(),
      "first vault: incomplete PIN details cannot seal the vault",
    );
  }
  await page.getByLabel("Device PIN", { exact: true }).fill(FIRST_VAULT_PIN);
  if (phone && process.env.TUTORIALS_KEYBOARD_VIEWPORT === "1") {
    await checkKeyboardViewport(page, check, label, {
      fieldLabel: "Device PIN",
      target: "unlock.seal-pin-entry",
      shot: "pin-keyboard",
    });
  }
  await page.locator(".coach__btn--go").click();
  await step("unlock.seal-pin-confirm", 6, 16);
  if (process.env.TUTORIALS_PIN_BACK === "1") {
    await checkTutorialNextBlocked(
      page,
      check,
      next,
      "unlock.seal-pin-confirm",
    );
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await step("unlock.seal-pin-entry", 5, 16);
    await next.click();
    await step("unlock.seal-pin-confirm", 6, 16);
  }
  await page.getByLabel("Confirm PIN", { exact: true }).fill(FIRST_VAULT_PIN);
  if (phone && process.env.TUTORIALS_KEYBOARD_VIEWPORT === "1") {
    await checkKeyboardViewport(page, check, label, {
      fieldLabel: "Confirm PIN",
      target: "unlock.seal-pin-confirm",
      shot: "confirm-pin-keyboard",
    });
  }
  await page.locator(".coach__btn--go").click();
  await step("unlock.seal-ack", 7, 16);
  check(
    await recovery.isChecked(),
    "first vault: recovery acknowledgment remains selected",
  );
  await page.locator(".coach__btn--go").click();
  await step("unlock.seal", 8, 16);
  if (phone && page.viewportSize().width <= 320)
    await checkLateSealScroll(page, step, check);
  // The seal step is an action step, so its Next is aria-disabled — a person
  // can still press it, and the card ignores the press. Playwright refuses to
  // click an aria-disabled key, so deliver the press the way the browser does
  // and prove both that the tour stayed on the seal and the screen did too.
  await next.evaluate((button) => button.click());
  check(
    (await page.locator('.coach[data-coach-target="unlock.seal"]').count()) ===
      1,
    "first vault: a pressed Next cannot skip sealing the PIN vault",
  );
  check(
    await page.getByRole("heading", { name: "Seal this device" }).isVisible(),
    "first vault: Next cannot skip sealing the PIN vault",
  );
  if (keepShots)
    await page.screenshot({
      path: `${out}/${width}-first-vault-${protection}.png`,
    });
  await page.getByRole("button", { name: "Seal with PIN" }).click();
}
