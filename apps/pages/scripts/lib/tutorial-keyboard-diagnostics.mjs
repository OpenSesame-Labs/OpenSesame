export function keyboardGeometry(page, target) {
  return page.evaluate((targetId) => {
    const card = document.querySelector(".coach__card");
    const field = document.querySelector(`[data-guide-targets~="${targetId}"]`);
    const rect = (node) => {
      const box = node?.getBoundingClientRect();
      return box && { top: box.top, bottom: box.bottom, height: box.height };
    };
    const bounds = field?.getBoundingClientRect();
    const hits = bounds
      ? document
          .elementsFromPoint(
            bounds.left + bounds.width / 2,
            bounds.top + bounds.height / 2,
          )
          .map((node) => `${node.tagName}.${node.className}`)
          .slice(0, 12)
      : [];
    const ancestors = [];
    for (let node = field?.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
        ancestors.push({
          className: node.className,
          overflow: style.overflowY,
          ...rect(node),
          clientHeight: node.clientHeight,
        });
      }
    }
    return {
      innerHeight: window.innerHeight,
      visualHeight: window.visualViewport?.height,
      visualTop: window.visualViewport?.offsetTop,
      card: rect(card),
      field: rect(field),
      cardClass: card?.className,
      maxHeight: card instanceof HTMLElement ? card.style.maxHeight : null,
      hits,
      ancestors,
    };
  }, target);
}

export async function checkKeyboardTarget(
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
