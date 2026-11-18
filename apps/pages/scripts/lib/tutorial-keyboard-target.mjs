/** Runs in the browser once the resized viewport and coach have settled. */
export function keyboardTargetReady(targetId) {
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
