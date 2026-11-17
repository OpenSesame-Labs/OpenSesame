import { type RefObject, useLayoutEffect, useState } from "react";
import {
  type UnlockHeroBox,
  placeUnlockHero,
} from "./unlock-hero-placement.js";

export type { UnlockHeroBox } from "./unlock-hero-placement.js";

/** Place the unlock hero above the form and independently of its width. */
export function useUnlockHeroLayout(
  paneRef: RefObject<HTMLElement | null>,
  cardRef: RefObject<HTMLElement | null>,
  notesRef: RefObject<HTMLElement | null>,
): UnlockHeroBox {
  const [box, setBox] = useState<UnlockHeroBox>({
    left: 40,
    top: 24,
    size: 56,
  });

  useLayoutEffect(() => {
    const pane = paneRef.current;
    const card = cardRef.current;
    if (!pane || !card) return;
    const place = () => {
      const next = placeUnlockHero(pane, card, notesRef.current);
      setBox((current) =>
        current.left === next.left &&
        current.top === next.top &&
        current.size === next.size
          ? current
          : next,
      );
    };

    place();
    let frame: number | undefined;
    const schedule = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        place();
      });
    };
    const cleanup = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      pane.style.paddingTop = "";
    };
    if (globalThis.ResizeObserver === undefined) {
      window.addEventListener("resize", schedule);
      return () => {
        window.removeEventListener("resize", schedule);
        cleanup();
      };
    }
    // Placement adjusts the observed pane's padding. Wait until the observer
    // delivery finishes and combine notices into one layout per frame.
    const observer = new ResizeObserver(schedule);
    observer.observe(pane);
    observer.observe(card);
    const notes = notesRef.current;
    if (notes) observer.observe(notes);
    return () => {
      observer.disconnect();
      cleanup();
    };
  }, [paneRef, cardRef, notesRef]);

  return box;
}
