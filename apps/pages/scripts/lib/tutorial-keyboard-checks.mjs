const fits = (card, button) =>
  Boolean(
    card &&
      button &&
      button.height >= 43.5 &&
      button.y >= card.y - 1 &&
      button.y + button.height <= card.y + card.height + 1,
  );

function isReachable(node) {
  const rect = node.getBoundingClientRect();
  const hit = document.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  );
  return hit !== null && node.contains(hit);
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
  const [cardBox, nextBox, exitBox] = await Promise.all([
    card.boundingBox(),
    next.boundingBox(),
    exit.boundingBox(),
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
    await card
      .locator(".coach__text")
      .evaluate((node) => node.scrollHeight <= node.clientHeight + 1),
    `${label}: the instruction is visible without scrolling`,
  );
}
