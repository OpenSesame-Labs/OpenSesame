/** Check that the tutorial instruction can be read or scrolled. */
export function readableInstruction(prose) {
  if (!prose) return false;
  const style = getComputedStyle(prose);
  const minimum = Math.min(
    prose.scrollHeight,
    2 * Number.parseFloat(style.lineHeight) +
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom),
  );
  return prose.clientHeight + 1 >= minimum;
}
