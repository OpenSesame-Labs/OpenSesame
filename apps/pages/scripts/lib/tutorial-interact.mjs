/**
 * The two ways a person works a tour that Next alone never touches: leaving it
 * with Escape, and making the move a step is waiting for. Each is done to a
 * real tutorial in a real browser, through the same keys and the same pointer
 * a person has, so a card that swallows a key or a dim that blocks the
 * aperture cannot pass.
 */

import { measureZoomedCompletion } from "./tutorial-measure-tools.mjs";
import {
  advancedFrom,
  readStep,
  resetToVault,
  startTutorial,
  unlockIfLocked,
} from "./tutorial-walk.mjs";

const gone = (page, timeout = 4000) =>
  page
    .waitForFunction(() => !document.querySelector(".coach"), undefined, {
      timeout,
    })
    .then(
      () => true,
      () => false,
    );

async function beginAt(page, { base, id }) {
  await resetToVault(page, base);
  await unlockIfLocked(page);
  await startTutorial(page, id);
  return readStep(page);
}

/** Puts focus on the real control a step points at; says whether it took. */
function focusControl(page, target) {
  return page.evaluate((id) => {
    const control = [
      ...document.querySelectorAll(`[data-guide-targets~="${id}"]`),
    ].find((node) => node.getClientRects().length > 0);
    if (!control) return false;
    control.focus();
    return document.activeElement === control;
  }, target);
}

/** Ends the tour if it is still up, then closes what a move opened (`opened`). */
async function leave(page, opened = null) {
  for (let presses = 0; presses < 4; presses += 1) {
    if (await gone(page, 300)) break;
    await page.keyboard.press("Escape");
  }
  if (opened === null) return true;
  // The list closes on a press outside it, the way a person dismisses it.
  if (await opened.isVisible())
    await page
      .locator(".project-switcher__backdrop")
      .click({ position: { x: 4, y: 4 } });
  return opened.waitFor({ state: "hidden", timeout: 3000 }).then(
    () => true,
    () => false,
  );
}

/**
 * Escape ends the tour with focus on the card, and again with focus on the
 * control the tour is lighting — the key a person reaches for in either place.
 * Uses `vault.lock`: its first step is a card with nothing lit, its second
 * points at the lock.
 */
export async function escapeEndsTheTour(page, { check, base }) {
  const id = "vault.lock";
  const first = await beginAt(page, { base, id });
  check(Boolean(first?.focusInCard), `${id}: focus starts on the card`);
  await page.keyboard.press("Escape");
  check(await gone(page), `${id}: Escape on the card ends the tour`);

  const opening = await beginAt(page, { base, id });
  if (!opening) return check(false, `${id}: the tutorial opens a card`);
  await page.locator(".coach__btn--go").click();
  check(await advancedFrom(page, opening), `${id}: Next reaches the lit step`);
  const lit = await readStep(page);
  const focused = lit?.target ? await focusControl(page, lit.target) : false;
  check(focused, `${id}: the lit control (${lit?.target}) can take focus`);
  await page.keyboard.press("Escape");
  check(await gone(page), `${id}: Escape on the lit control ends the tour`);
  await leave(page);
}

/**
 * A step that waits for the person's move advances when the move is made on
 * the lit control through the aperture. `vaults.switch` waits for the tomb
 * segment to be pressed, which only opens the list of vaults.
 */
export async function moveAdvancesTheTour(page, { check, base }) {
  const id = "vaults.switch";
  let info = await beginAt(page, { base, id });
  for (let steps = 0; info && !info.action && steps < 6; steps += 1) {
    await page.locator(".coach__btn--go").click();
    if (!(await advancedFrom(page, info))) break;
    info = await readStep(page);
  }
  check(Boolean(info?.action), `${id}: a step waits for the person's move`);
  const opened = page.locator(".project-switcher__menu");
  if (!info?.action || !info.probe?.visible) {
    await leave(page, opened);
    return;
  }
  await page.mouse.click(info.probe.x, info.probe.y);
  check(
    await advancedFrom(page, info),
    `${id}: making the move on ${info.target} through the aperture advances the tour`,
  );
  check(
    await leave(page, opened),
    `${id}: the list the move opened can be dismissed`,
  );
}

/** Zoom and pan the phone, then use the highlighted setup control by touch. */
export async function checkZoomViewport(page, check) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    await checkZoomPosition(page, check, "zoomed");
    const { width, y } = await page.evaluate(() => ({
      width: visualViewport.width,
      y: Math.min(
        visualViewport.height - 2,
        document
          .querySelector('[data-guide-targets~="unlock.setup"]')
          .getBoundingClientRect().top -
          visualViewport.offsetTop -
          2,
      ),
    }));
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: width * 0.8, y }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: width * 0.2, y }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForFunction(() => visualViewport.offsetLeft > 0);
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          let previous = visualViewport.offsetLeft;
          let stable = 0;
          let frames = 0;
          const frame = () => {
            const next = visualViewport.offsetLeft;
            stable = Math.abs(next - previous) < 0.1 ? stable + 1 : 0;
            previous = next;
            if (stable >= 4 || ++frames >= 120) resolve();
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        }),
    );
    await checkZoomPosition(page, check, "zoomed and panned");
    if (process.env.TUTORIALS_SHOTS === "1" && process.env.TUTORIALS_OUT) {
      await page.screenshot({
        path: `${process.env.TUTORIALS_OUT}/${page.viewportSize().width}-setup-panned.png`,
      });
    }
    const point = await page.evaluate(() => {
      const v = visualViewport;
      const target = document
        .querySelector('[data-guide-targets~="unlock.setup"]')
        .getBoundingClientRect();
      return {
        x:
          (Math.max(target.left, v.offsetLeft) +
            Math.min(target.right, v.offsetLeft + v.width)) /
            2 -
          v.offsetLeft,
        y:
          (Math.max(target.top, v.offsetTop) +
            Math.min(target.bottom, v.offsetTop + v.height)) /
            2 -
          v.offsetTop,
      };
    });
    await page.touchscreen.tap(point.x, point.y);
    await page.locator('.coach[data-coach-target="setup.default"]').waitFor();
    check(true, "first vault: the setup control works by touch while zoomed");
  } finally {
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    await session.detach();
  }
}

async function checkZoomPosition(page, check, label) {
  await page.waitForFunction(() => {
    const card = document
      .querySelector(".coach__card")
      ?.getBoundingClientRect();
    const v = visualViewport;
    return (
      card &&
      Math.abs(card.left - v.offsetLeft - 8) < 1 &&
      card.right <= v.offsetLeft + v.width - 7
    );
  });
  const result = await page.evaluate(() => {
    const v = visualViewport;
    const card = document.querySelector(".coach__card");
    const text = card.querySelector(".coach__text");
    const exit = card.querySelector('[aria-label="Exit tutorial"]');
    const target = document.querySelector(
      '[data-guide-targets~="unlock.setup"]',
    );
    const box = (element) => element.getBoundingClientRect();
    const a = box(card),
      b = box(target),
      c = box(exit);
    text.scrollTop = text.scrollHeight;
    return {
      inside:
        a.left >= v.offsetLeft &&
        a.right <= v.offsetLeft + v.width &&
        a.top >= v.offsetTop &&
        a.bottom <= v.offsetTop + v.height,
      clear:
        a.bottom <= b.top ||
        a.top >= b.bottom ||
        a.right <= b.left ||
        a.left >= b.right,
      readable:
        text.clientHeight > 0 &&
        text.scrollTop + text.clientHeight >= text.scrollHeight - 1,
      exit:
        c.width >= 44 &&
        c.height >= 44 &&
        c.left >= a.left &&
        c.right <= a.right &&
        c.top >= a.top &&
        c.bottom <= a.bottom,
    };
  });
  check(
    result.inside,
    `first vault: the ${label} card fits the visible viewport`,
  );
  check(result.clear, `first vault: the ${label} card leaves setup clear`);
  check(result.readable, `first vault: the ${label} instruction can be read`);
  check(result.exit, `first vault: the ${label} exit remains in reach`);
}

/** Swipe the short card to its controls, as on a phone. */
export async function checkShortKeyboardCard(page, session, check) {
  const swipe = await page.evaluate(() => {
    const v = visualViewport;
    const node = document.querySelector(".coach__card");
    const card = node.getBoundingClientRect();
    const text = node.querySelector(".coach__text");
    const bounds = text.getBoundingClientRect();
    const controls = [...node.querySelectorAll(".coach__keys button")];
    return {
      x: card.right - v.offsetLeft - 8,
      from: card.bottom - v.offsetTop - 4,
      to: card.top - v.offsetTop + 4,
      controlsOffscreen: controls.every(
        (control) => control.getBoundingClientRect().top >= card.bottom,
      ),
      firstLineVisible:
        bounds.top >= card.top &&
        bounds.top + parseFloat(getComputedStyle(text).lineHeight) <=
          card.bottom,
    };
  });
  check(
    swipe.firstLineVisible,
    "first vault: the short card shows its instruction before scrolling",
  );
  check(
    swipe.controlsOffscreen,
    "first vault: the short card does not partially show its controls",
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
    const card = document.querySelector(".coach__card");
    return (
      card.scrollTop > 0 &&
      card.scrollTop + card.clientHeight >= card.scrollHeight - 1
    );
  });
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const card = document.querySelector(".coach__card");
        const started = performance.now();
        let previous = card.scrollTop;
        let since = started;
        const frame = () => {
          const now = performance.now();
          if (card.scrollTop !== previous) {
            previous = card.scrollTop;
            since = now;
          }
          if (now - since >= 200) resolve();
          else if (now - started > 5000)
            reject(new Error("The short card kept scrolling."));
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
  check(true, "first vault: the short card scrolls to its controls by touch");
}

/** Finish the tour by touch at 2× zoom in a short phone viewport. */
export async function closeWithZoomCheck(page, check) {
  const original = page.viewportSize();
  const controls = await page.evaluate(measureZoomedCompletion);
  check(
    controls.allFit,
    "first vault: completion controls fit and are reachable",
  );
  check(
    await page
      .getByRole("button", { name: "Replay steps", exact: true })
      .isVisible(),
    "first vault: Replay steps is accessible by its visible label",
  );
  if (process.env.TUTORIALS_KEYBOARD_VIEWPORT !== "1" || original.width > 390) {
    await page.getByRole("button", { name: "Done", exact: true }).click();
    return;
  }
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    await page.setViewportSize({ width: original.width, height: 190 });
    await page.waitForFunction(() => {
      const card = document.querySelector(".coach__card--short-scroll");
      const box = card?.getBoundingClientRect();
      const v = visualViewport;
      return (
        box &&
        box.left >= v.offsetLeft &&
        box.right <= v.offsetLeft + v.width &&
        box.top >= v.offsetTop &&
        box.bottom <= v.offsetTop + v.height
      );
    });
    if (process.env.TUTORIALS_SHOTS === "1" && process.env.TUTORIALS_OUT)
      await page.screenshot({
        path: `${process.env.TUTORIALS_OUT}/${original.width}-zoomed-close-instruction.png`,
      });
    await checkShortKeyboardCard(page, session, check);
    const result = await page.evaluate(measureZoomedCompletion);
    check(
      result.allFit,
      "first vault: zoomed completion controls fit and remain touch-sized",
    );
    if (process.env.TUTORIALS_SHOTS === "1" && process.env.TUTORIALS_OUT)
      await page.screenshot({
        path: `${process.env.TUTORIALS_OUT}/${original.width}-zoomed-close-controls.png`,
      });
    await page.touchscreen.tap(result.point.x, result.point.y);
    await page.waitForFunction(() => !document.querySelector(".coach"));
    check(true, "first vault: Done works by touch while zoomed");
  } finally {
    await page.setViewportSize(original);
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    await session.detach();
  }
}
