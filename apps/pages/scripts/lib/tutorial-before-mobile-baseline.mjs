/** Phone setup-path baseline on pre–first-vault main (per install profile). */

import path from "node:path";
import {
  applySetupChoice,
  captureChoices,
  openDoor,
} from "./verification-checklist-setup.mjs";

/** Shell/setup coaches can sit above the choice row; step through narrate beats. */
async function clearCoachOverlay(page) {
  for (let i = 0; i < 12; i++) {
    if ((await page.locator(".coach").count()) === 0) return;
    const notNow = page.getByRole("button", { name: "Not now" });
    if (await notNow.count()) {
      await notNow.click({ timeout: 3_000 }).catch(() => {});
      if ((await page.locator(".coach").count()) === 0) return;
    }
    const next = page.locator(".coach__btn--go");
    if (!(await next.count())) return;
    await next.click({ force: true, timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(150);
  }
}

/**
 * @param {object} opts
 * @param {(width: number) => Promise<{ page: import('playwright').Page; context: import('playwright').BrowserContext }>} opts.newPage
 * @param {string} opts.origin
 * @param {string} opts.base
 * @param {string} opts.out
 * @param {{ setupChoice: string }} opts.walk
 */
export async function runBeforeMobileBaseline({
  newPage,
  origin,
  base,
  out,
  walk,
}) {
  const { page, context } = await newPage(390);
  const record = { checks: [] };
  const href = `${origin}${base}`;
  const shot = async (name) => {
    const file = path.join(out, `390-before-${name}.png`);
    await page.screenshot({ path: file, animations: "disabled" });
    return file;
  };
  try {
    await context.addInitScript(() =>
      Object.defineProperty(navigator, "webdriver", { get: () => false }),
    );
    await openDoor(page, shot, record, href);
    await captureChoices(page, shot, record);
    await clearCoachOverlay(page);
    await applySetupChoice(page, shot, record, walk.setupChoice);
    await page.screenshot({
      path: path.join(out, "390-before-post-setup.png"),
      animations: "disabled",
    });
  } finally {
    await context.close();
  }
}
