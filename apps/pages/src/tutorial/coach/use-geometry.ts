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
  isTightViewport,
} from "./placement.js";
import { observeScrollIntent } from "./use-coach-behavior.js";

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
  const horizontal =
    box.width <= width && (visible?.width ?? 0) < box.width - 1;
  const vertical =
    box.height <= height && (visible?.height ?? 0) < box.height - 1;
  return horizontal || vertical;
}

/** Leave room for navigation when zoom and the keyboard leave a short screen. */
function needsRoom(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView?.visualViewport;
  if (
    !view ||
    !isTightViewport(view) ||
    element.ownerDocument.activeElement !== element ||
    !element.matches("input, textarea, [contenteditable=true]")
  )
    return false;
  const box = element.getBoundingClientRect();
  const above = box.top - view.offsetTop;
  const below = view.offsetTop + view.height - box.bottom;
  return Math.max(above, below) < 70;
}

function revealTarget(
  element: HTMLElement,
  box: VisibleTargetRect | null,
): boolean {
  const makeRoom = needsRoom(element);
  if (!makeRoom && !needsReveal(element, box)) return false;
  element.scrollIntoView?.({
    block: makeRoom ? "start" : "center",
    inline: "nearest",
    behavior: "auto",
  });
  return true;
}

function nextRevealTime(
  element: HTMLElement,
  box: VisibleTargetRect | null,
  next: number,
): number {
  if (!needsRoom(element) && !needsReveal(element, box)) return 0;
  const now = performance.now();
  return now >= next && revealTarget(element, box) ? now + 250 : next;
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
    let nextReveal = 0;
    let manuallyScrolled = false;
    const viewport = window.visualViewport;
    const refit = (): void => {
      if (manuallyScrolled) return;
      nextReveal = 0;
    };
    const stopReveal = (): void => {
      manuallyScrolled = true;
    };
    const stopObservingScroll = observeScrollIntent(stopReveal, () =>
      latest.current.resolve(),
    );
    window.addEventListener("resize", refit);
    viewport?.addEventListener("resize", refit);
    const tick = (): void => {
      const { resolve: current, key: currentKey } = latest.current;
      const element = current();
      if (observedKey !== currentKey) {
        observedKey = currentKey;
        absent = false;
        manuallyScrolled = false;
        refit();
      }
      if (!element) absent = true;
      else if (absent) {
        // Reopening a target is a new request to find it, even after scrolling.
        manuallyScrolled = false;
        refit();
        element.scrollIntoView?.({
          block: "center",
          inline: "nearest",
          behavior: "auto",
        });
        nextReveal = performance.now() + 250;
        absent = false;
      }
      const box = element ? visibleTargetRect(element) : null;
      if (element && !manuallyScrolled)
        nextReveal = nextRevealTime(element, box, nextReveal);
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
      stopObservingScroll();
    };
  }, []);
  return rect.key === key ? rect.box : null;
}

type VisualSize = Size & {
  readonly scale: number;
  readonly offsetLeft: number;
  readonly rightOffset: number;
  readonly offsetTop: number;
  readonly bottomOffset: number;
};

const readViewport = (): VisualSize => {
  const visual = window.visualViewport;
  const layoutWidth = document.documentElement.clientWidth;
  const width = visual?.width ?? layoutWidth;
  const height = visual?.height ?? window.innerHeight;
  const offsetLeft = visual?.offsetLeft ?? 0;
  const offsetTop = visual?.offsetTop ?? 0;
  return {
    width,
    height,
    scale: visual?.scale ?? 1,
    offsetLeft,
    offsetTop,
    rightOffset: Math.max(0, layoutWidth - offsetLeft - width),
    bottomOffset: Math.max(0, window.innerHeight - offsetTop - height),
  };
};

/** The visual viewport's size, following rotation and the on-screen keyboard. */
export function useViewport(): VisualSize {
  const [size, setSize] = useState<VisualSize>(readViewport);
  useEffect(() => {
    const update = (): void => {
      setSize((held) => {
        const next = readViewport();
        return held.width === next.width &&
          held.height === next.height &&
          held.scale === next.scale &&
          held.offsetLeft === next.offsetLeft &&
          held.rightOffset === next.rightOffset &&
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
