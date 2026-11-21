/** Phone setup-path baseline on pre–first-vault main (per install profile). */

import path from "node:path";
import { dismissFirstVisitOffer } from "./dismiss-first-visit.mjs";
import { openDoor, pickSetupChoice } from "./verification-checklist-setup.mjs";

async function clearCoachOverlay(page) {
  for (let i = 0; i < 16; i++) {
    if ((await page.locator(".coach__dim").count()) === 0) return;
    await dismissFirstVisitOffer(page);
    const next = page.locator(".coach__btn--go");
    if (await next.count()) {
      await next.click({ force: true, timeout: 3_000 }).catch(() => {});
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
    await page.waitForTimeout(200);
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
    await dismissFirstVisitOffer(page);
    await clearCoachOverlay(page);
    const setupOwn = page.getByRole("button", {
      name: "Set up your own",
      exact: true,
    });
    await setupOwn.waitFor({ state: "visible", timeout: 15_000 });
    await setupOwn.evaluate((button) => button.click());
    await page
      .getByRole("button", { name: walk.setupChoice, exact: true })
      .waitFor({ timeout: 15_000 });
    await shot("setup-choices");
    await clearCoachOverlay(page);
    await pickSetupChoice(page, walk.setupChoice, { shot, record });
    await page.screenshot({
      path: path.join(out, "390-before-post-setup.png"),
      animations: "disabled",
    });
  } finally {
    await context.close();
  }
}
