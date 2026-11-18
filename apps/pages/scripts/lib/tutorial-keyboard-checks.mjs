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

export async function checkKeyboardCard(
  page,
  check,
  label,
  { back = false } = {},
) {
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
