// Native CTAP2.1 WebAuthn walks: real PRF success, unsupported-PRF fallback,
// and a browser with WebAuthn absent. The older stub helper remains for its
// separate fixture test.
import {
  addVirtualAuthenticator,
  stubPrfResults,
} from "./auth-flow-harness.mjs";
import { sealPinFirstVault } from "./auth-flow-pin-journey.mjs";
import { passTheDoor } from "./front-door.mjs";
import { PIN } from "./pages-journey.mjs";
import { expect } from "./patient-expect.mjs";
import { AUTHENTICATOR } from "./quorum-browser-rig.mjs";
import {
  checkControlReachable,
  checkTutorialNextBlocked,
  waitForSecurityKey,
} from "./tutorial-measure.mjs";

export async function addTutorialAuthenticator(context, page, prf) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      ...AUTHENTICATOR,
      transport: "internal",
      hasResidentKey: true,
      hasPrf: prf,
    },
  });
}

/** Seal through browser-backed PRF, or exercise every PIN fallback control. */
export async function sealFirstVault(
  page,
  { step, check, phone, protection, label, out, width, keepShots },
) {
  const recovery = page.getByLabel(
    "I understand this vault cannot be recovered.",
  );
  const next = page.locator(".coach__btn--go");
  check(
    await recovery.isVisible(),
    `${protection} first vault: recovery acknowledgment is visible`,
  );
  await checkControlReachable(
    page,
    check,
    recovery,
    `${protection} recovery notice`,
  );
  if (protection !== "pin-only") {
    await checkTutorialNextBlocked(page, check, next);
    const passkeyTab = page.getByRole("tab", { name: "Passkey" });
    await passkeyTab.waitFor({ state: "visible", timeout: 30_000 });
    check(
      (await passkeyTab.getAttribute("aria-selected")) === "true",
      `${protection} first vault: passkey leads the seal`,
    );
    const deviceTab = page.getByRole("tab", { name: "This device" });
    await deviceTab.waitFor({ state: "visible", timeout: 30_000 });
    check(
      (await deviceTab.getAttribute("aria-selected")) === "true",
      `${protection} first vault: This device is the default passkey road`,
    );
    const sealPasskey = page.getByRole("button", {
      name: "Seal with passkey",
    });
    check(
      await sealPasskey.isVisible(),
      `${protection} first vault: Seal with passkey is visible`,
    );
    await checkControlReachable(
      page,
      check,
      sealPasskey,
      `${protection} Seal with passkey`,
    );
    await recovery.check();
    if (protection === "passkey") {
      await sealPasskey.click();
      return;
    }
    await sealPasskey.click();
    await waitForSecurityKey(page, { out, width, label, keepShots });
    check(
      await page.getByRole("tab", { name: "Security key" }).isVisible(),
      "first vault: unavailable device passkey offers Security key",
    );
    // Start the real cross-platform prompt, then choose PIN to cancel it as a
    // person would when no security key is available.
    await sealPasskey.click();
    await page.getByRole("tab", { name: "PIN", exact: true }).click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="tab"][aria-selected="true"]')
          ?.textContent?.trim() === "PIN",
    );
    check(
      (await page
        .getByText(
          "This device's passkey cannot seal a vault. Security key is selected.",
          { exact: true },
        )
        .count()) === 0,
      "first vault: PIN selection clears the stale passkey notice",
    );
    // The passkey road's fallback is named by the held seal step, which waits
    // for the unlock itself; the PIN fields are walked as tour steps only on
    // the PIN-only road below, so fill and seal the way a person would here.
    await page.getByLabel("Device PIN", { exact: true }).fill(PIN);
    await page.getByLabel("Confirm PIN", { exact: true }).fill(PIN);
    await page.getByRole("button", { name: "Seal with PIN" }).click();
    return;
  }
  await sealPinFirstVault(page, {
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

async function reachSealScreen(page, ORIGIN, BASE) {
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await passTheDoor(page);
  await page.getByRole("button", { name: "Use without an account" }).click();
  await page
    .getByRole("heading", { name: "Seal this device" })
    .waitFor({ timeout: 15000 });
}

async function unlockWithPasskey(page, check, snap, stepName) {
  const unlocked = async () =>
    page
      .getByRole("link", { name: "New item", exact: true })
      .waitFor({ timeout: 20000 })
      .then(
        () => true,
        () => false,
      );
  await page.getByRole("button", { name: "Unlock with passkey" }).click();
  check(await unlocked(), `${stepName}: Unlock with passkey opened the vault`);
  await snap(page, `${stepName}-unlocked-again`);
}

export async function passkeyJourneys(context) {
  await passkeyPrfJourney(context);
  for (const protocol of ["ctap2", "ctap2_1"]) {
    await passkeyNoPrfJourney(context, protocol);
  }
}

async function passkeyPrfJourney({
  browser,
  newPage,
  check,
  snap,
  setStep,
  lock,
  ORIGIN,
  BASE,
}) {
  // ---- 4: PRF results stubbed — seal and unlock with a passkey
  setStep("4-passkey-prf");
  const { page, context } = await newPage(browser);
  await stubPrfResults(page);
  await addVirtualAuthenticator(context, page, "ctap2_1");
  await reachSealScreen(page, ORIGIN, BASE);
  const sealed = await snap(page, "4-passkey-seal-screen");
  check(
    (await page
      .getByRole("tab", { name: "Passkey" })
      .getAttribute("aria-selected")) === "true",
    "the passkey tab leads the first-run seal",
  );
  check(
    /the PIN tab works on any device/.test(sealed),
    "the seal copy points at the PIN tab fallback",
  );
  await page
    .getByLabel("I understand this vault cannot be recovered.", {
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "Seal with passkey" }).click();
  const inside = await page
    .getByRole("link", { name: "New item", exact: true })
    .waitFor({ timeout: 20000 })
    .then(
      () => true,
      () => false,
    );
  check(inside, "Seal with passkey landed inside the app");
  await snap(page, "4-passkey-sealed");
  await lock(page);
  const locked = await snap(page, "4-passkey-locked");
  check(/^Unlock$/m.test(locked), "lock lands on Unlock");
  check(
    (await page.getByRole("tab", { name: "Passkey" }).count()) === 1,
    "the passkey tab is offered on the locked screen",
  );
  await unlockWithPasskey(page, check, snap, "4-passkey-prf");
  await context.close();
}

async function passkeyNoPrfJourney(
  { browser, newPage, check, snap, setStep, ORIGIN, BASE },
  protocol,
) {
  // ---- 5: PRF off — the seal steps past to the Security key road
  setStep(`5-passkey-no-prf-${protocol}`);
  const { page, context } = await newPage(browser);
  await addVirtualAuthenticator(context, page, protocol);
  await reachSealScreen(page, ORIGIN, BASE);
  check(
    (await page
      .getByRole("tab", { name: "This device" })
      .getAttribute("aria-selected")) === "true",
    "the device road leads the passkey seal",
  );
  await page
    .getByLabel("I understand this vault cannot be recovered.", {
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "Seal with passkey" }).click();
  const steppedPast = await expect(
    page.getByRole("tab", { name: "Security key" }),
  )
    .toHaveAttribute("aria-selected", "true")
    .then(
      () => true,
      () => false,
    );
  check(steppedPast, "the seal stepped past to the Security key road");
  check(
    (await page.locator(".notice-corner .notice-card--err").count()) === 0,
    "no error card — stepping past is not a failure",
  );
  check(
    (await page.getByRole("dialog", { name: "Notifications" }).count()) === 0,
    "the tray sheet stays closed — the caret keeps its field",
  );
  check(
    (await page.getByRole("heading", { name: "Seal this device" }).count()) ===
      1,
    "still on Seal this device",
  );
  await page.getByRole("button", { name: /Notifications.*pending/ }).click();
  const tray = page.getByRole("dialog", { name: "Notifications" });
  const trayShown = await tray.waitFor({ timeout: 15000 }).then(
    () => true,
    () => false,
  );
  check(
    trayShown && /cannot seal a vault/.test((await tray.textContent()) ?? ""),
    "the tray says why in a plain line",
  );
  await snap(page, `5-passkey-no-prf-${protocol}`);
  await context.close();
}
