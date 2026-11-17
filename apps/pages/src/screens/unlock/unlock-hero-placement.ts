/** Width of the rendered wordmark in em, including its mark and gaps. */
const WORD_UNITS = 7.78;
const MAX_EM = 90;
const GAP_WIDE = 34;
const GAP_NARROW = 20;
const NARROW_BP = 1100;
const COL_MARGIN = 60;
const WIDE_LEFT_INSET = 40;
const WIDE_LEFT_RATIO = 0.096;
const NARROW_BASE_PAD_TOP = 32;

export type UnlockHeroBox = { left: number; top: number; size: number };

/** Fit the hero above the form, keeping it clear of the notes divider. */
export function placeUnlockHero(
  pane: HTMLElement,
  card: HTMLElement,
  notes: HTMLElement | null,
): UnlockHeroBox {
  const paneRect = pane.getBoundingClientRect();
  const narrow = paneRect.width < NARROW_BP;
  const gap = narrow ? GAP_NARROW : GAP_WIDE;
  let cardRect = card.getBoundingClientRect();
  let cardX = cardRect.left - paneRect.left;
  let available: number;
  let alignRight: number;
  if (narrow) {
    available = cardRect.width;
    alignRight = cardX + cardRect.width;
  } else {
    const notesLeft = notes
      ? notes.getBoundingClientRect().left - paneRect.left
      : paneRect.width;
    const leftInset = Math.max(WIDE_LEFT_INSET, notesLeft * WIDE_LEFT_RATIO);
    alignRight = notesLeft - COL_MARGIN;
    available = Math.max(120, alignRight - leftInset);
  }
  let size = Math.max(28, Math.min(MAX_EM, available / WORD_UNITS));
  if (size * WORD_UNITS > available) size = available / WORD_UNITS;
  // Covers the canvas padding and measured glyphs without oversizing the band.
  const height = size * 1.05;
  if (narrow) {
    const padding = `${NARROW_BASE_PAD_TOP + height + gap}px`;
    if (pane.style.paddingTop !== padding) pane.style.paddingTop = padding;
    const updatedPane = pane.getBoundingClientRect();
    cardRect = card.getBoundingClientRect();
    cardX = cardRect.left - updatedPane.left;
    return {
      left: cardX,
      top: Math.max(8, cardRect.top - updatedPane.top - gap - height),
      size,
    };
  }
  if (pane.style.paddingTop) pane.style.paddingTop = "";
  return {
    left: Math.max(
      WIDE_LEFT_INSET,
      (alignRight + COL_MARGIN) * WIDE_LEFT_RATIO,
    ),
    top: Math.max(
      8,
      Math.min(
        paneRect.height * 0.158,
        cardRect.top - paneRect.top - gap - height,
      ),
    ),
    size,
  };
}
