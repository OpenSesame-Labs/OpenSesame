import { checkShortKeyboardCard } from "./tutorial-interact.mjs";
import {
  keyboardGeometry,
  measureZoomedKeyboard,
} from "./tutorial-measure-tools.mjs";
import { captureZoomedInstruction } from "./tutorial-page.mjs";
import { readStep } from "./tutorial-walk.mjs";

export async function checkKeyboardViewport(
  page,
  check,
  label,
  { fieldLabel = "Name", target = "item.editor.name", shot = "keyboard" } = {},
) {
  const original = page.viewportSize();
  if (!original) throw new Error("The phone viewport is unavailable.");
  const field = page.getByLabel(fieldLabel, { exact: true });
  const keyboardHeight = target === "item.editor.name" ? 190 : 240;
  await field.click();
  try {
    await page.setViewportSize({
      width: original.width,
      height: keyboardHeight,
    });
    await page.waitForFunction(
      (height) =>
        (window.visualViewport?.height ?? window.innerHeight) <= height + 0.5,
      keyboardHeight,
      { timeout: 5000 },
    );
    await field.evaluate((node) =>
      node.scrollIntoView({ block: "center", inline: "nearest" }),
    );
    try {
      await page.waitForFunction(keyboardTargetReady, target, {
        timeout: 5000,
      });
    } catch {
      const geometry = await keyboardGeometry(page, target);
      throw new Error(
        `The coach did not fit the shortened viewport: ${JSON.stringify(geometry)}`,
      );
    }
    const info = await readStep(page);
    await checkKeyboardTarget(page, check, label, fieldLabel, target, info);
    if (process.env.TUTORIALS_SHOTS === "1" && process.env.TUTORIALS_OUT) {
      const name = label.replaceAll(" ", "-");
      await page.screenshot({
        path: `${process.env.TUTORIALS_OUT}/${original.width}-${name}-${shot}.png`,
      });
    }
    await checkKeyboardCard(page, check, `${label} · ${fieldLabel}`, {
      back: target === "unlock.seal-pin-confirm",
    });
  } finally {
    await page.setViewportSize(original);
    await page.waitForFunction(
      (height) =>
        (window.visualViewport?.height ?? window.innerHeight) >= height - 0.5,
      original.height,
      { timeout: 5000 },
    );
  }
  if (
    original.width <= 390 &&
    (target === "unlock.seal-pin-entry" ||
      target === "unlock.seal-pin-confirm" ||
      target === "item.editor.name")
  ) {
    await checkZoomedKeyboard(page, check, field, target, keyboardHeight);
    if (target === "unlock.seal-pin-confirm")
      await checkZoomedKeyboard(page, check, field, target, 190);
  }
}

async function checkZoomedKeyboard(page, check, field, target, keyboardHeight) {
  const original = page.viewportSize();
  const session = await page.context().newCDPSession(page);
  let moved = "";
  try {
    await field.focus();
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    await page.setViewportSize({
      width: original.width,
      height: keyboardHeight,
    });
    await page.waitForFunction((id) => {
      const field = document.querySelector(`[data-guide-targets~="${id}"]`);
      const card = document.querySelector(".coach__card");
      const v = visualViewport;
      if (!field || !card || v.scale < 1.9) return false;
      const input = field.getBoundingClientRect();
      const box = card.getBoundingClientRect();
      return (
        Math.abs(input.top - v.offsetTop) < 2 &&
        box.left >= v.offsetLeft + 7 &&
        box.right <= v.offsetLeft + v.width - 7 &&
        box.top >= v.offsetTop &&
        box.bottom <= v.offsetTop + v.height + 1 &&
        box.height >= v.height - input.height - 15
      );
    }, target);
    if (target === "item.editor.name") {
      const wholeWord = await page.evaluate(() => {
        const node = document.querySelector(".coach__message")?.firstChild;
        const start = node?.textContent?.indexOf("account") ?? -1;
        if (!node || start < 0) return false;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + "account".length);
        return range.getClientRects().length === 1;
      });
      check(wholeWord, "first vault: zoomed instruction keeps words intact");
    }
    await captureZoomedInstruction(
      page,
      session,
      check,
      original.width,
      target,
      keyboardHeight,
    );
    if (await page.locator(".coach__card--short-scroll").count())
      await checkShortKeyboardCard(page, session, check);
    const result = await page.evaluate(measureZoomedKeyboard, target);
    if (!result.clear || !result.inside || !result.readable || !result.controls)
      console.log(
        `  Zoomed keyboard ${target}: ${JSON.stringify(result.geometry)}`,
      );
    if (process.env.TUTORIALS_SHOTS === "1" && process.env.TUTORIALS_OUT) {
      await page.screenshot({
        path: `${process.env.TUTORIALS_OUT}/${original.width}-${target}-${keyboardHeight}-zoomed-keyboard.png`,
      });
    }
    check(result.clear, `first vault: zoomed keyboard leaves ${target} clear`);
    check(
      result.inside,
      `first vault: zoomed keyboard card fits the visible viewport`,
    );
    check(
      result.readable,
      "first vault: zoomed keyboard instruction can be read",
    );
    check(
      result.controls,
      "first vault: zoomed keyboard controls fit and remain touch-sized",
    );
    if (target === "item.editor.name") {
      const point = await field.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const v = visualViewport;
        return {
          x:
            (Math.max(box.left, v.offsetLeft) +
              Math.min(box.right, v.offsetLeft + v.width)) /
              2 -
            v.offsetLeft,
          y:
            (Math.max(box.top, v.offsetTop) +
              Math.min(box.bottom, v.offsetTop + v.height)) /
              2 -
            v.offsetTop,
        };
      });
      await page.touchscreen.tap(point.x, point.y);
      check(
        await field.evaluate((node) => document.activeElement === node),
        "first vault: the zoomed account name field is touch-reachable",
      );
    }
    if (target === "unlock.seal-pin-entry") {
      await page.touchscreen.tap(result.point.x, result.point.y);
      await page
        .locator('.coach[data-coach-target="unlock.seal-pin-confirm"]')
        .waitFor();
      check(
        true,
        "first vault: Next works by touch with the zoomed keyboard open",
      );
      moved = "next";
    } else if (target === "unlock.seal-pin-confirm") {
      await page.touchscreen.tap(result.backPoint.x, result.backPoint.y);
      await page
        .locator('.coach[data-coach-target="unlock.seal-pin-entry"]')
        .waitFor();
      check(
        true,
        "first vault: Back works by touch with the zoomed keyboard open",
      );
      moved = "back";
    }
  } finally {
    await page.setViewportSize(original);
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    await session.detach();
  }
  if (moved) {
    await page
      .getByRole("button", {
        name: moved === "next" ? "Back" : "Next",
        exact: true,
      })
      .click();
    await page.locator(`.coach[data-coach-target="${target}"]`).waitFor();
  }
}

/** Runs in the browser once the resized viewport and coach have settled. */
function keyboardTargetReady(targetId) {
  const card = document.querySelector(".coach__card");
  const target = document.querySelector(`[data-guide-targets~="${targetId}"]`);
  if (!card?.classList.contains("coach__card--constrained") || !target)
    return false;
  const a = card.getBoundingClientRect();
  const b = target.getBoundingClientRect();
  const hit = document.elementFromPoint(
    b.left + b.width / 2,
    b.top + b.height / 2,
  );
  return (
    b.width > 0 &&
    b.height > 0 &&
    hit !== null &&
    target.contains(hit) &&
    !(
      a.left < b.right &&
      a.right > b.left &&
      a.top < b.bottom &&
      a.bottom > b.top
    )
  );
}

async function checkKeyboardTarget(
  page,
  check,
  label,
  fieldLabel,
  target,
  info,
) {
  const card = info?.card;
  const field = info?.visibleControl;
  const overlap =
    card &&
    field &&
    card.left < field.right &&
    card.right > field.left &&
    card.top < field.bottom &&
    card.bottom > field.top;
  const clear = Boolean(card && field && !overlap);
  const reachable = info?.probe?.onControl === true;
  if (!clear || !reachable)
    console.log(
      `  Keyboard geometry for ${fieldLabel}: ${JSON.stringify(await keyboardGeometry(page, target))}`,
    );
  check(
    clear,
    `${label}: the shortened viewport keeps the card off ${fieldLabel}`,
  );
  check(
    reachable,
    `${label}: ${fieldLabel} remains reachable while the keyboard is open`,
  );
}

const fits = (card, button) =>
  Boolean(
    card &&
      button &&
      button.height >= 43.5 &&
      button.y >= card.y - 1 &&
      button.y + button.height <= card.y + card.height + 1,
  );

const contained = (outer, inner) =>
  Boolean(
    outer &&
      inner &&
      inner.x >= outer.x - 1 &&
      inner.y >= outer.y - 1 &&
      inner.x + inner.width <= outer.x + outer.width + 1 &&
      inner.y + inner.height <= outer.y + outer.height + 1,
  );

const separated = (a, b) =>
  Boolean(
    a &&
      b &&
      (a.x + a.width <= b.x + 1 ||
        b.x + b.width <= a.x + 1 ||
        a.y + a.height <= b.y + 1 ||
        b.y + b.height <= a.y + 1),
  );

function isReachable(node) {
  const rect = node.getBoundingClientRect();
  const hit = document.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  );
  return hit !== null && node.contains(hit);
}

function probeLongInstruction(node) {
  const extra = document.createElement("span");
  const previousScroll = node.scrollTop;
  extra.textContent = " More tutorial details.".repeat(30);
  node.append(extra);
  try {
    node.scrollTop = node.scrollHeight;
    const rect = node.getBoundingClientRect();
    const card = node.closest(".coach__card")?.getBoundingClientRect();
    const target = document
      .querySelector(".coach__ring")
      ?.getBoundingClientRect();
    return {
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      card: card && {
        x: card.x,
        y: card.y,
        width: card.width,
        height: card.height,
      },
      target: target && {
        x: target.x,
        y: target.y,
        width: target.width,
        height: target.height,
      },
      scrollable: node.scrollTop > 0,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    };
  } finally {
    extra.remove();
    node.scrollTop = previousScroll;
  }
}

async function checkKeyboardCard(page, check, label, { back = false } = {}) {
  const card = page.locator(".coach__card");
  const next = page.locator(".coach__btn--go");
  const exit = page.getByRole("button", { name: "Exit tutorial" });
  const instruction = card.locator(".coach__text");
  const [cardBox, nextBox, exitBox, instructionBox] = await Promise.all([
    card.boundingBox(),
    next.boundingBox(),
    exit.boundingBox(),
    instruction.boundingBox(),
  ]);
  check(
    fits(cardBox, nextBox),
    `${label}: the full-size Next button is visible without scrolling`,
  );
  check(
    await next.evaluate(isReachable),
    `${label}: Next remains reachable while the keyboard is open`,
  );
  check(
    fits(cardBox, exitBox),
    `${label}: the full-size Exit button stays visible`,
  );
  check(
    await exit.evaluate(isReachable),
    `${label}: Exit remains reachable while the keyboard is open`,
  );
  if (back) {
    const previous = page.getByRole("button", { name: "Back", exact: true });
    check(
      fits(cardBox, await previous.boundingBox()),
      `${label}: Back stays visible while the keyboard is open`,
    );
    check(
      await previous.evaluate(isReachable),
      `${label}: Back remains reachable while the keyboard is open`,
    );
  }
  check(
    contained(cardBox, instructionBox),
    `${label}: the instruction stays inside the card`,
  );
  check(
    await instruction.evaluate(
      (node) => node.scrollHeight <= node.clientHeight + 1,
    ),
    `${label}: the instruction is visible without scrolling`,
  );
  const overflow = await instruction.evaluate(probeLongInstruction);
  check(
    contained(overflow.card, overflow.box) && overflow.scrollable,
    `${label}: longer instructions remain in the card and can be scrolled (${JSON.stringify(overflow)})`,
  );
  check(
    separated(overflow.card, overflow.target),
    `${label}: longer instructions leave the highlighted control uncovered`,
  );
}
