/**
 * Apply a setup road, seal a local vault, and assert profile-specific vault DOM.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import {
  awaitCapabilitySections,
  capabilityOnSwitch,
} from "./always-on.mjs";
import { openSettingsCategory, sealLocalOnly, waitOpen } from "./pages-journey.mjs";
import { visibleClick } from "./verification-checklist-shot.mjs";
async function openSetupChoices(page, href) {
  await page.goto(href, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "Set up your own", exact: true })
    .click();
  const frame = page.locator(".setup__frame");
  await frame.waitFor({ timeout: 20_000 });
  await page
    .getByRole("button", { name: "Default", exact: true })
    .waitFor({ timeout: 15_000 });
}

async function shotFrame(page, file) {
  const frame = page.locator(".setup__frame");
  await frame.waitFor({ timeout: 15_000 });
  await page.waitForTimeout(350);
  await frame.screenshot({ path: file, animations: "disabled" });
}

async function confirmMinimal(page, dir, check) {
  await page.waitForTimeout(400);
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
    const warning = path.join(dir, "setup-minimal-confirm-tray.png");
    await page
      .locator(".vault, .setup__frame, body")
      .first()
      .screenshot({ path: warning, animations: "disabled" })
      .catch(() => page.screenshot({ path: warning, animations: "disabled" }));
    await dialog.getByRole("button", { name: "Use Minimal anyway" }).click();
  } catch {
    try {
      await anyway.first().waitFor({ state: "visible", timeout: 4_000 });
      await anyway.first().click();
    } catch {
      // Main-line builds may commit Minimal without the extra confirm step.
    }
  }
}

async function finishCustom(page, check) {
  await page
    .getByRole("tab", { name: /^capabilities$/i })
    .waitFor({ timeout: 20_000 });
  await page
    .getByRole("button", { name: /^Customize this installation/ })
    .click();
  const personal = page.getByTestId("purpose-card-personal");
  await personal.waitFor({ state: "visible", timeout: 12_000 });
  await personal.click();
  const review = page.getByRole("button", {
    name: "Save on this device",
    exact: true,
  });
  await review.waitFor({ state: "visible", timeout: 12_000 });
  await review.click();
  const apply = page.getByRole("button", { name: "Apply configuration" });
  await apply.waitFor({ state: "visible", timeout: 15_000 });
  await apply.click();
  const outcome = page.getByTestId("capability-outcome");
  await outcome.waitFor({ state: "visible", timeout: 25_000 });
  const text = await outcome.innerText();
  check(/applied|durable|session/i.test(text), `custom ceremony applied: ${text}`);
  const skipped = await visibleClick(page, "button", "Skip all", 12_000);
  if (!skipped) await visibleClick(page, "button", "Close", 8_000);
}

async function waitPastSetup(page) {
  const signIn = page.getByRole("heading", { level: 1, name: "Sign in" });
  const lock = page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true");
  await signIn.or(lock).first().waitFor({ timeout: 45_000 });
  if (
    await lock
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    return "app";
  }
  if (await signIn.isVisible().catch(() => false)) return "sign-in";
  return "unknown";
}

async function enableCoreItemTypesIfOffered(page) {
  const enable = page.getByRole("button", {
    name: "Turn on passwords, cards and notes",
    exact: true,
  });
  if ((await enable.count()) === 1) await enable.click();
}

async function shotVault(page, file) {
  await page.waitForTimeout(350);
  const vault = page.locator(".vault").first();
  await vault.waitFor({ state: "visible", timeout: 15_000 });
  await vault.screenshot({ path: file, animations: "disabled" });
}

async function switchOn(page, title) {
  return (await capabilityOnSwitch(page, title).count()) > 0;
}

export async function vaultFeatureMarkers(page) {
  await openSettingsCategory(page, "Features");
  await awaitCapabilitySections(page);
  const onSwitches = page.locator(
    '[role="switch"][aria-checked="true"][data-capability-title]',
  );
  const onSwitchCount = await onSwitches.count();
  const markers = {
    onSwitchCount,
    externalConnectors: await switchOn(page, "External connectors"),
    passkeyRecords: await switchOn(page, "Passkey records"),
    certificateRecords: await switchOn(page, "Certificate records"),
    derivedTypes: await switchOn(page, "Derived item types"),
    liveSessions: await switchOn(page, "Live sessions"),
    browserLocalIam: await switchOn(page, "Browser-local IAM"),
    accessAuthority: await switchOn(page, "Access authority"),
    identityFederation: await switchOn(page, "Operator identity providers"),
  };
  const back = page.getByRole("treeitem", { name: "Back to vault" });
  if (await back.isVisible().catch(() => false)) await back.click();
  return markers;
}

export async function vaultRailMarkers(page) {
  const enableCore = await page.getByRole("button", {
    name: "Turn on passwords, cards and notes",
    exact: true,
  }).count();
  const account = await page.locator('a[href$="/vault?f=account"]').count();
  const card = await page.locator('a[href$="/vault?f=card"]').count();
  const note = await page.locator('a[href$="/vault?f=note"]').count();
  const passkey = await page.locator('a[href$="/vault?f=passkey"]').count();
  const certificate = await page
    .locator('a[href$="/vault?f=certificate"]')
    .count();
  const itemFilters = account + card + note + passkey + certificate;
  return {
    enableCore,
    account,
    card,
    note,
    passkey,
    certificate,
    itemFilters,
  };
}

export function profileMarkerKey(markers) {
  return JSON.stringify(markers);
}

/** DOM proof that the committed plan matches the setup road. */
export function assertProfileVaultDom(profileId, markers, check) {
  const {
    enableCore,
    account,
    passkey,
    certificate,
    itemFilters,
    onSwitchCount,
    externalConnectors,
    passkeyRecords,
    certificateRecords,
    liveSessions,
    browserLocalIam,
    accessAuthority,
    identityFederation,
    derivedTypes,
  } = markers;
  if (profileId === "minimal") {
    check(
      enableCore === 1 && itemFilters === 0,
      `minimal vault: no item-type filters until enabled (${JSON.stringify(markers)})`,
    );
    check(
      !externalConnectors &&
        !passkeyRecords &&
        !certificateRecords &&
        !liveSessions &&
        onSwitchCount <= 1,
      `minimal vault: no optional features on (${JSON.stringify(markers)})`,
    );
    return;
  }
  if (profileId === "default") {
    check(
      account > 0 && passkey > 0 && certificate > 0,
      `default vault: password + passkey + certificate filters (${JSON.stringify(markers)})`,
    );
    check(
      externalConnectors &&
        passkeyRecords &&
        certificateRecords &&
        accessAuthority &&
        browserLocalIam,
      `default vault: Default extensions on in Features (${JSON.stringify(markers)})`,
    );
    check(
      !liveSessions && onSwitchCount >= 5 && onSwitchCount <= 12,
      `default vault: moderate feature count (${onSwitchCount})`,
    );
    return;
  }
  if (profileId === "full") {
    check(
      itemFilters >= 5,
      `full vault: full item-type rail (${itemFilters})`,
    );
    check(
      onSwitchCount >= 18,
      `full vault: broad feature approval (${onSwitchCount} switches on)`,
    );
    check(
      externalConnectors && liveSessions,
      `full vault: connectors and live sessions on (${JSON.stringify(markers)})`,
    );
    return;
  }
  if (profileId === "custom") {
    check(
      enableCore === 1 && passkey === 0 && certificate === 0,
      `custom personal vault: secrets only in the rail (${JSON.stringify(markers)})`,
    );
    check(
      liveSessions && onSwitchCount <= 2,
      `custom personal vault: Live sessions selected (${JSON.stringify(markers)})`,
    );
    check(
      !externalConnectors && !passkeyRecords && !derivedTypes,
      `custom personal vault: no Default extension pack (${JSON.stringify(markers)})`,
    );
  }
}

export async function captureProfileAppliedVault(
  page,
  href,
  dir,
  profileId,
  check,
) {
  await openSetupChoices(page, href);
  const picker = path.join(dir, "setup-profile-picker.png");
  await shotFrame(page, picker);
  check(existsSync(picker), `${profileId} setup-profile-picker.png`);

  const choice =
    profileId === "minimal"
      ? "Minimal"
      : profileId === "default"
        ? "Default"
        : profileId === "custom"
          ? "Custom"
          : "Full";
  await page.getByRole("button", { name: choice, exact: true }).click();
  if (profileId === "minimal") await confirmMinimal(page, dir, check);
  if (profileId === "custom") await finishCustom(page, check);

  const landed = await waitPastSetup(page);
  check(
    landed === "sign-in" || landed === "app",
    `${profileId} applied past setup (${landed})`,
  );
  if (landed === "sign-in") await sealLocalOnly(page);
  else await waitOpen(page);

  await page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first()
    .waitFor({ timeout: 25_000 });

  if (profileId === "default" || profileId === "full") {
    await enableCoreItemTypesIfOffered(page);
  }

  const markers = {
    ...(await vaultRailMarkers(page)),
    ...(await vaultFeatureMarkers(page)),
  };
  assertProfileVaultDom(profileId, markers, check);

  const applied = path.join(dir, "setup-profile-applied.png");
  await shotVault(page, applied);
  check(existsSync(applied), `${profileId} setup-profile-applied.png`);
  return { file: applied, picker, markers };
}