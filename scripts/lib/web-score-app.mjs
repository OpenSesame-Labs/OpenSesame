import { chromium } from "@playwright/test";
import { realVisitorChromeArgs } from "./web-score-common.mjs";

/** A score cannot pass for a static placeholder or a failed app bootstrap. */
export async function checkAppReady({
  chrome,
  targetUrl,
  noSandbox,
  browserType = chromium,
}) {
  const browser = await browserType.launch({
    executablePath: chrome,
    headless: true,
    chromiumSandbox: !noSandbox,
    args: realVisitorChromeArgs,
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(targetUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    if (await page.evaluate(() => navigator.webdriver)) {
      throw new Error("browser is not showing the default visitor experience");
    }
    const setup = page.getByRole("button", {
      name: "Set up your own",
      exact: true,
    });
    await setup.waitFor({ state: "visible", timeout: 60_000 });
    // Default guidance may open on arrival. Dismiss it through its own control,
    // as a person can, before verifying that the underlying road works.
    const exit = page.getByRole("button", { name: "Exit tutorial" });
    await exit.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    if (await exit.isVisible()) {
      await exit.click();
      await exit.waitFor({ state: "hidden" });
    }
    for (const name of ["Join a session", "Import passwords from a file"]) {
      const road = page.getByRole("button", { name });
      await road.waitFor({ state: "visible", timeout: 30_000 });
      if (
        (await road.count()) !== 1 ||
        !(await road.isVisible()) ||
        !(await road.isEnabled())
      ) {
        throw new Error(`the app did not show ${name}`);
      }
    }
    // Clicking a real control prevents a painted but inert facsimile from
    // qualifying. The context is disposable and stores no real vault.
    await setup.click();
    await page
      .getByRole("button", { name: "Skip all" })
      .waitFor({ timeout: 30_000 });
    if (errors.length) throw new Error(`page error: ${errors[0]}`);
  } finally {
    await browser.close();
  }
}
