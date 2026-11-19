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
