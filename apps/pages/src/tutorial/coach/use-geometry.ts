import {
  type VisibleTargetRect,
  visibleTargetRect,
} from "@opensesame/app-core/tutorial/registry/visible-target.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type Box,
  NO_INSETS,
  type SafeInsets,
  type Size,
} from "./placement.js";

function sameBox(a: Box | null, b: Box | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

/** Ignore the coach itself when checking whether another surface covers a target. */
function uncovered(element: HTMLElement, box: VisibleTargetRect): boolean {
  const doc = element.ownerDocument;
  if (!doc.elementsFromPoint) return true;
  const points = [
    [0.5, 0.5],
    [0.1, 0.1],
    [0.9, 0.1],
    [0.1, 0.9],
    [0.9, 0.9],
  ];
  return points.some(([x, y]) => {
    const hit = doc
      .elementsFromPoint(
        box.left + box.width * (x ?? 0.5),
        box.top + box.height * (y ?? 0.5),
      )
      .find((node) => !node.closest(".coach"));
    return hit !== undefined && element.contains(hit);
  });
}

/** A control that fits should remain fully visible after the viewport changes. */
function needsReveal(
  element: HTMLElement,
  visible: VisibleTargetRect | null,
): boolean {
  const box = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  if (!view || box.width <= 0 || box.height <= 0) return false;
  const width = view.visualViewport?.width ?? view.innerWidth;
  const height = view.visualViewport?.height ?? view.innerHeight;
  if (box.width > width || box.height > height) return false;
  return (
    visible === null ||
    visible.width < box.width - 1 ||
    visible.height < box.height - 1
  );
}

/**
 * The live rectangle of whatever `resolve` returns, one frame behind at most.
 *
 * The target moves for reasons a component cannot subscribe to — a pane
 * scrolls, a sheet slides in, a list reflows when the vault finishes loading
 * — so the rectangle is read each frame and a change is published only when
 * it is at least half a pixel. A tour is on screen for seconds, and the read
 * is one `getBoundingClientRect`; polling is the honest design here.
 */
export function useLiveRect(
  resolve: () => HTMLElement | null,
  key: string,
): Box | null {
  const [rect, setRect] = useState<{ key: string; box: Box | null }>({
    key,
    box: null,
  });
  const latest = useRef({ resolve, key });
  latest.current = { resolve, key };
  useEffect(() => {
    let frame = 0;
    let observedKey = "";
    let absent = false;
    let revealFrames = 0;
    let revealAttempts = 0;
    const viewport = window.visualViewport;
    const refit = (): void => {
      // Recheck briefly as the browser and the page settle after a resize.
      revealFrames = 16;
      revealAttempts = 0;
    };
    window.addEventListener("resize", refit);
    viewport?.addEventListener("resize", refit);
    const tick = (): void => {
      const { resolve: current, key: currentKey } = latest.current;
      const element = current();
      if (observedKey !== currentKey) {
        observedKey = currentKey;
        absent = false;
        refit();
      }
      if (!element) absent = true;
      else if (absent) {
        // A panel can close after a step starts and reopen with its target
        // below the viewport. Bring it back once; do not fight later scrolling.
        element.scrollIntoView?.({
          block: "center",
          inline: "nearest",
          behavior: "auto",
        });
        absent = false;
      }
      const box = element ? visibleTargetRect(element) : null;
      if (
        element &&
        revealFrames > 0 &&
        revealAttempts < 2 &&
        needsReveal(element, box)
      ) {
        element.scrollIntoView?.({
          block: "center",
          inline: "nearest",
          behavior: "auto",
        });
        revealAttempts += 1;
      }
      if (revealFrames > 0) revealFrames -= 1;
      const next: Box | null =
        box && element && uncovered(element, box)
          ? {
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height,
            }
          : null;
      setRect((held) =>
        held.key === currentKey && sameBox(held.box, next)
          ? held
          : { key: currentKey, box: next },
      );
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", refit);
      viewport?.removeEventListener("resize", refit);
    };
  }, []);
  return rect.key === key ? rect.box : null;
}

type VisualSize = Size & {
  readonly offsetTop: number;
  readonly bottomOffset: number;
};

const readViewport = (): VisualSize => ({
  width: document.documentElement.clientWidth,
  height: window.visualViewport?.height ?? window.innerHeight,
  offsetTop: window.visualViewport?.offsetTop ?? 0,
  bottomOffset: Math.max(
    0,
    window.innerHeight -
      (window.visualViewport?.offsetTop ?? 0) -
      (window.visualViewport?.height ?? window.innerHeight),
  ),
});

/** The visual viewport's size, following rotation and the on-screen keyboard. */
export function useViewport(): VisualSize {
  const [size, setSize] = useState<VisualSize>(readViewport);
  useEffect(() => {
    const update = (): void => {
      setSize((held) => {
        const next = readViewport();
        return held.width === next.width &&
          held.height === next.height &&
          held.offsetTop === next.offsetTop &&
          held.bottomOffset === next.bottomOffset
          ? held
          : next;
      });
    };
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, []);
  return size;
}

/** Whether the shell is drawing its phone layout (DESIGN.md § Touch). */
export function usePhoneLayout(): boolean {
  const query = "(max-width: 900px), (pointer: coarse)";
  const [phone, setPhone] = useState(
    () => globalThis.matchMedia?.(query).matches ?? false,
  );
  useEffect(() => {
    const list = globalThis.matchMedia?.(query);
    if (!list) return;
    const update = (): void => setPhone(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, []);
  return phone;
}

/** The measured size of an element, kept current as its content changes. */
export function useMeasured(
  ref: React.RefObject<HTMLElement | null>,
  watch: string,
): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `watch` re-measures when the step's content changes.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = (): void => {
      const box = node.getBoundingClientRect();
      setSize((held) =>
        held &&
        Math.abs(held.width - box.width) < 0.5 &&
        Math.abs(held.height - box.height) < 0.5
          ? held
          : { width: box.width, height: box.height },
      );
    };
    measure();
    if (!("ResizeObserver" in globalThis)) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ref, watch]);
  return size;
}

/**
 * The safe-area insets the docked card's CSS adds to its offset. `env()` is
 * only readable through a style, so a probe element resolves it and the
 * computed padding is the number.
 */
export function readSafeInsets(): SafeInsets {
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;left:0;top:0;" +
    "padding-top:env(safe-area-inset-top,0px);" +
    "padding-bottom:env(safe-area-inset-bottom,0px)";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const read = (value: string): number => {
    const px = Number.parseFloat(value);
    return Number.isFinite(px) && px > 0 ? px : 0;
  };
  const insets = {
    top: read(style.paddingTop),
    bottom: read(style.paddingBottom),
  };
  probe.remove();
  return insets;
}

/** The safe-area insets, re-read when the window turns or resizes. */
export function useSafeInsets(): SafeInsets {
  const [insets, setInsets] = useState<SafeInsets>(NO_INSETS);
  useEffect(() => {
    const update = (): void => {
      setInsets((held) => {
        const next = readSafeInsets();
        return held.top === next.top && held.bottom === next.bottom
          ? held
          : next;
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return insets;
}
