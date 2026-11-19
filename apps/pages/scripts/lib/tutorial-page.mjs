const PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
};

export const isPhone = (width) =>
  width < 600 || process.env.TUTORIALS_TOUCH === "1";

async function observeResizeErrors(page, context, harness) {
  // Chromium reports ResizeObserver delivery failures as window errors even
  // when it does not emit Playwright's `pageerror` event.
  await page.exposeBinding("__recordTutorialResizeError", () =>
    harness.record("PAGE-ERROR", "ResizeObserver loop notification"),
  );
  await context.addInitScript(() => {
    window.addEventListener("error", (event) => {
      if (event.message.startsWith("ResizeObserver loop")) {
        void window.__recordTutorialResizeError();
      }
    });
  });
}

export function createTutorialPageFactory({ browser, devUrl, harness }) {
  return async function newPage(width) {
    const height =
      Number(process.env.TUTORIALS_HEIGHT) || (width <= 320 ? 568 : 844);
    const screen = isPhone(width)
      ? { ...PHONE, viewport: { width, height } }
      : {
          viewport: {
            width,
            height: Number(process.env.TUTORIALS_HEIGHT) || 900,
          },
        };
    const colorScheme = process.env.TUTORIALS_COLOR_SCHEME;
    const device = { ...screen };
    if (colorScheme === "dark" || colorScheme === "light") {
      device.colorScheme = colorScheme;
    }
    if (!devUrl) {
      const result = await harness.newPage(browser, { device });
      await observeResizeErrors(result.page, result.context, harness);
      return result;
    }
    const context = await browser.newContext(device);
    const page = await context.newPage();
    page.on("pageerror", (error) =>
      harness.record("PAGE-ERROR", String(error.message).slice(0, 300)),
    );
    await observeResizeErrors(page, context, harness);
    return { page, context };
  };
}

/** The filter sheet is opened and its choice selected by the person. */
export const isFilterAction = (info) =>
  info?.action &&
  ["vault.filter", "vault.filter.favorites", "vault.filter.logins"].includes(
    info.target,
  );

export async function pressFilterAction(page, { info, check, label, phone }) {
  const next = page.locator(".coach__btn--go");
  check(
    (await next.getAttribute("aria-disabled")) === "true",
    `${label}: Next waits for the filter action`,
  );
  const sheet = page.getByRole("dialog", { name: "Filter items" });
  if (info.target === "vault.filter") {
    check(
      !(await sheet.isVisible()),
      `${label}: the filter sheet starts closed`,
    );
    if (await next.isVisible()) {
      await next.focus();
      await page.keyboard.press("Enter");
      check(
        (await page
          .locator('.coach[data-coach-target="vault.filter"]')
          .count()) === 1,
        `${label}: Next cannot skip opening Filter`,
      );
    }
  } else {
    check(await sheet.isVisible(), `${label}: the filter sheet is open`);
    check(
      await page.locator(".coach__btn--back").isDisabled(),
      `${label}: Back cannot return to the covered opener`,
    );
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await sheet.waitFor({ state: "hidden" });
    const opener = page.locator('[data-guide-targets~="vault.filter"]:visible');
    if (phone) await opener.tap();
    else await opener.click();
    await sheet.waitFor({ state: "visible" });
    check(true, `${label}: the filter sheet can be reopened`);
  }
  const target = page
    .locator(`[data-guide-targets~="${info.target}"]:visible`)
    .first();
  if (phone) await target.tap();
  else await target.click();
}
