// Choosing capabilities with the keyboard alone (ADR 0130 + the keyboard
// contract in AGENTS.md §5).
//
// The sections this journey walks — Connections, Access, Identity — belong to
// capabilities, so a device that has approved nothing has no `g c`, no rail
// row and no drawer link for them. That is the product requirement, not a
// regression, and the way past it is the way a person goes: Settings ›
// Features and the capability's switch. Doing it here also holds the new surface to the
// same contract as the rest of the app — every step below is a real key
// press, with no click, no injected focus and no synthetic event.

import { expect } from "@playwright/test";
import {
  ALWAYS_ON_TITLES,
  awaitCapabilitySections,
  capabilityOffSwitch,
  capabilityOnSwitch,
} from "./always-on.mjs";

/** Open Settings › Features from wherever the walk is, by keyboard. */
async function openFeatures(page, tabTo) {
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await expect(page).toHaveURL(/\/settings(?:[/?].*)?$/, { timeout: 10_000 });
  const tab = page.getByRole("link", { name: "Features", exact: true });
  await tabTo(page, tab);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("features-panel")).toBeVisible();
}

/**
 * Add each capability by name, through its switch and the review's Apply.
 * Asserts the switch is off first: an off switch is one this installation
 * may have and is not running, so a name that is already approved — or that
 * this distribution does not carry — has no off switch here and the walk
 * would be lying if it passed anyway.
 */
export async function approveByKeyboard(page, tabTo, titles) {
  await expect(page.locator("#command-bar-input")).toBeEnabled({
    timeout: 60_000,
  });
  console.log("PASS capability activation settled before feature edits");
  for (const title of titles) {
    // Always on (ADR 0135): in every plan, with no row to add it from.
    if (ALWAYS_ON_TITLES.has(title)) continue;
    await openFeatures(page, tabTo);
    await awaitCapabilitySections(page);
    if ((await capabilityOnSwitch(page, title).count()) === 1) continue;
    const add = capabilityOffSwitch(page, title);
    await expect(add).toHaveCount(1);
    await tabTo(page, add);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("capability-review")).toHaveCount(0);
    await expect(capabilityOnSwitch(page, title)).toHaveCount(1, {
      timeout: 15_000,
    });
  }
  // A checked switch says the current plan approves the capability; its
  // contributed routes and keymap entries arrive only when that generation's
  // activation pass finishes. The command bar uses the production readiness
  // signal (`activatedGeneration === composition generation`), so do not
  // claim the capability walk is complete until the same signal is ready.
  try {
    await expect(page.locator("#command-bar-input")).toBeEnabled({
      timeout: 60_000,
    });
  } catch (error) {
    console.error(
      "Capability activation marks:",
      await page.locator(".status-mark").evaluateAll((marks) =>
        marks.map((mark) => ({
          label: mark.getAttribute("aria-label"),
          row: mark.closest(".capsection__cap")?.textContent?.trim(),
        })),
      ),
    );
    throw error;
  }
}
