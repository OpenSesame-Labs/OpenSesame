/** Runs in the browser with the measurement's geometry and visibility helpers. */
export function measureButton(node, box, pointable) {
  const bounds = box(node);
  const hit = bounds
    ? document.elementFromPoint(
        (bounds.left + bounds.right) / 2,
        (bounds.top + bounds.bottom) / 2,
      )
    : null;
  return {
    box: bounds,
    reachable: Boolean(node && hit && node.contains(hit)),
    disabled: node ? node.disabled : null,
    ariaDisabled: node?.getAttribute("aria-disabled") === "true",
    visible: node ? pointable(node) : false,
  };
}
