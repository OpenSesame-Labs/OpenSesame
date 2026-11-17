/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUnlockHeroLayout } from "./use-unlock-hero-layout.js";

function element(left: number, top: number, width: number, height: number) {
  const node = document.createElement("div");
  // SAFETY: the hook reads only the box edges and size, which this fixture rect sets; it never calls toJSON or reads x and y.
  node.getBoundingClientRect = () =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    }) as DOMRect;
  return { current: node };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("lets the wide hero span the left pane independently of the narrower form", () => {
  vi.stubGlobal("ResizeObserver", undefined);
  const pane = element(0, 0, 1663, 946);
  const card = element(293, 286, 352, 430);
  const notes = element(831.5, 0, 831.5, 946);
  const { result } = renderHook(() => useUnlockHeroLayout(pane, card, notes));
  const hero = result.current;
  expect(hero.left).toBeGreaterThan(75);
  expect(hero.left).toBeLessThan(85);
  expect(hero.top).toBeGreaterThan(145);
  expect(hero.top).toBeLessThan(155);
  expect(hero.size * 7.78).toBeGreaterThan(680);
  expect(hero.left + hero.size * 7.78).toBeLessThanOrEqual(831.5 - 24);
  expect(hero.top + hero.size * 1.05).toBeLessThan(
    card.current.getBoundingClientRect().top,
  );
});

it("reserves a separate hero band on a phone and fits within the form gutter", () => {
  vi.stubGlobal("ResizeObserver", undefined);
  const pane = element(0, 0, 320, 568);
  const card = element(20, 120, 280, 430);
  const notes = element(20, 570, 280, 120);
  const { result } = renderHook(() => useUnlockHeroLayout(pane, card, notes));
  const hero = result.current;
  expect(hero.left).toBe(20);
  expect(hero.left + hero.size * 7.78).toBeLessThanOrEqual(300);
  expect(hero.top + hero.size * 1.05).toBeLessThanOrEqual(100);
  expect(Number.parseFloat(pane.current.style.paddingTop)).toBeGreaterThan(80);
});

it("coalesces observed resize work until the next frame and cancels it on unmount", () => {
  let notify = () => {};
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  class Observer {
    constructor(callback: () => void) {
      notify = callback;
    }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", Observer);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const pane = element(0, 0, 320, 568);
  const card = element(20, 120, 280, 430);
  const notes = element(20, 570, 280, 120);
  const { result, unmount } = renderHook(() =>
    useUnlockHeroLayout(pane, card, notes),
  );
  const initialPadding = pane.current.style.paddingTop;
  const initialSize = result.current.size;
  card.current.getBoundingClientRect = () =>
    element(20, 120, 220, 430).current.getBoundingClientRect();

  notify();
  notify();
  expect(frames.size).toBe(1);
  expect(pane.current.style.paddingTop).toBe(initialPadding);
  expect(result.current.size).toBe(initialSize);
  act(() => {
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback(0);
  });
  expect(result.current.size).toBeLessThan(initialSize);
  expect(pane.current.style.paddingTop).not.toBe(initialPadding);

  notify();
  expect(frames.size).toBe(1);
  unmount();
  expect(frames.size).toBe(0);
  expect(pane.current.style.paddingTop).toBe("");
});

it("updates placement on viewport resize when ResizeObserver is unavailable", () => {
  vi.stubGlobal("ResizeObserver", undefined);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const pane = element(0, 0, 320, 568);
  const card = element(20, 120, 280, 430);
  const notes = element(20, 570, 280, 120);
  const { result, unmount } = renderHook(() =>
    useUnlockHeroLayout(pane, card, notes),
  );
  const initialSize = result.current.size;
  card.current.getBoundingClientRect = () =>
    element(20, 120, 220, 430).current.getBoundingClientRect();
  window.dispatchEvent(new Event("resize"));
  expect(frames.size).toBe(1);
  act(() => {
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback(0);
  });
  expect(result.current.size).toBeLessThan(initialSize);
  unmount();
  window.dispatchEvent(new Event("resize"));
  expect(frames.size).toBe(0);
});
