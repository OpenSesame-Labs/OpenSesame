const PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
};

export const isPhone = (width) =>
  width < 600 || process.env.TUTORIALS_TOUCH === "1";

/** Swipe the overflowing instruction itself, as on a zoomed phone. */
async function checkInstructionTouchScroll(page, session, check) {
  await page.waitForFunction(() =>
    document.querySelector(".coach__text")?.classList.contains("is-scrollable"),
  );
  const swipe = await page.evaluate(() => {
    const text = document.querySelector(".coach__text");
    const box = text.getBoundingClientRect();
    const view = visualViewport;
    const cue = text.querySelector(".coach__scroll-cue");
    return {
      cue: getComputedStyle(cue, "::before").content,
      cueVisible: getComputedStyle(cue).display !== "none",
      cueHidden: cue.getAttribute("aria-hidden") === "true",
      x: box.left + box.width / 2 - view.offsetLeft,
      from: box.bottom - view.offsetTop - 3,
      to: box.top - view.offsetTop + 3,
    };
  });
  check(
    swipe.cue.includes("↕") && swipe.cueVisible && swipe.cueHidden,
    "first vault: overflowing instructions show a scroll cue",
  );
  const narration = await page.locator(".coach__text").ariaSnapshot();
  check(
    !narration.includes("↕"),
    "first vault: the scroll cue is not announced",
  );
  for (let i = 0; i < 2; i += 1) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: swipe.x, y: swipe.from }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: swipe.x, y: swipe.to }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  }
  await page.waitForFunction(() => {
    const text = document.querySelector(".coach__text");
    return (
      text.scrollTop > 0 &&
      text.scrollTop + text.clientHeight >= text.scrollHeight - 1
    );
  });
  const lastLineVisible = await page.evaluate(() => {
    const text = document.querySelector(".coach__text");
    const range = document.createRange();
    range.selectNodeContents(text.querySelector(".coach__message"));
    const last = [...range.getClientRects()].at(-1);
    const clip = text.getBoundingClientRect();
    return last && last.top >= clip.top && last.bottom <= clip.bottom;
  });
  check(
    lastLineVisible,
    "first vault: touch scrolling reveals the rest of the instruction",
  );
}

export async function captureZoomedInstruction(
  page,
  session,
  check,
  width,
  target,
  keyboardHeight,
) {
  const overflowCase =
    target === "unlock.seal-pin-entry" && keyboardHeight === 240;
  const shots =
    process.env.TUTORIALS_SHOTS === "1" && process.env.TUTORIALS_OUT;
  if (overflowCase)
    await page.waitForFunction(() =>
      document
        .querySelector(".coach__text")
        ?.classList.contains("is-scrollable"),
    );
  if (shots)
    await page.screenshot({
      path: `${process.env.TUTORIALS_OUT}/${width}-${target}-${keyboardHeight}-zoomed-instruction.png`,
    });
  if (target === "unlock.seal-pin-confirm" && keyboardHeight === 190) {
    const cueStable = await page.evaluate(async () => {
      const text = document.querySelector(".coach__text");
      if (!text) return false;
      let previous = text.classList.contains("is-scrollable");
      let changes = 0;
      for (let i = 0; i < 10; i += 1) {
        await new Promise(requestAnimationFrame);
        const current = text.classList.contains("is-scrollable");
        if (current !== previous) changes += 1;
        previous = current;
      }
      return changes < 2;
    });
    check(cueStable, "first vault: the scroll cue remains stable");
  }
  if (!overflowCase) return;
  await checkInstructionTouchScroll(page, session, check);
  if (shots)
    await page.screenshot({
      path: `${process.env.TUTORIALS_OUT}/${width}-${target}-zoomed-instruction-scrolled.png`,
    });
}

/** The gate's tutorial prompt must leave the PIN acknowledgment reachable. */
export async function checkGatePausePrompt(page, check, width, out, phone) {
  const prompt = page.getByText("Pause tutorials for this session?", {
    exact: true,
  });
  await prompt.waitFor({ state: "visible" });
  check(
    await prompt.evaluate((node) => Boolean(node.closest(".notice-corner"))),
    "gate: the tutorial pause choice is in the page flow",
  );
  if (process.env.TUTORIALS_SHOTS === "1") {
    await prompt.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}/${width}-gate-pause-flow.png` });
  }
  const checkbox = page.getByRole("checkbox", {
    name: "I understand this vault cannot be recovered.",
  });
  const session = await page.context().newCDPSession(page);
  try {
    for (const scale of phone ? [1, 2] : [1]) {
      await session.send("Emulation.setPageScaleFactor", {
        pageScaleFactor: scale,
      });
      await checkbox.evaluate((node) =>
        node.scrollIntoView({ block: "center", inline: "nearest" }),
      );
      const point = await checkbox.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const v = visualViewport;
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          x: x - v.offsetLeft,
          y: y - v.offsetTop,
          clear:
            x >= v.offsetLeft &&
            x < v.offsetLeft + v.width &&
            y >= v.offsetTop &&
            y < v.offsetTop + v.height &&
            (hit === node || node.labels?.[0]?.contains(hit)),
        };
      });
      if (process.env.TUTORIALS_SHOTS === "1")
        await page.screenshot({
          path: `${out}/${width}-gate-pause-${scale}x.png`,
        });
      check(point.clear, `gate: the PIN acknowledgment is clear at ${scale}x`);
      if (!point.clear) continue;
      const before = await checkbox.isChecked();
      const press = () =>
        phone
          ? page.touchscreen.tap(point.x, point.y)
          : page.mouse.click(point.x, point.y);
      await press();
      check(
        (await checkbox.isChecked()) !== before,
        `gate: the PIN acknowledgment works at ${scale}x`,
      );
      await press();
    }
  } finally {
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    await session.detach();
  }
}

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
