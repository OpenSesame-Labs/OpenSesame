/** @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observeResize,
  readSafeInsets,
  useLiveRect,
  useViewport,
} from "./use-geometry.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("defers and coalesces resize measurements and cancels them on cleanup", () => {
  let notify = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const measure = vi.fn();
  const stop = observeResize(document.createElement("p"), measure);

  notify();
  notify();
  expect(measure).not.toHaveBeenCalled();
  expect(frames.size).toBe(1);
  frames.get(nextFrame)?.(0);
  expect(measure).toHaveBeenCalledTimes(1);

  notify();
  stop();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
});

describe("readSafeInsets", () => {
  it("reads the resolved top and bottom insets from a probe", () => {
    // SAFETY: fixture constructed in this test matches the declared contract.
    vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({
      paddingTop: "47px",
      paddingBottom: "34px",
    } as CSSStyleDeclaration);
    expect(readSafeInsets()).toEqual({ top: 47, bottom: 34 });
    expect(document.body.children).toHaveLength(0);
  });

  it("is zero where env() resolves to nothing", () => {
    // SAFETY: fixture constructed in this test matches the declared contract.
    vi.spyOn(globalThis, "getComputedStyle").mockReturnValue({
      paddingTop: "",
      paddingBottom: "0px",
    } as CSSStyleDeclaration);
    expect(readSafeInsets()).toEqual({ top: 0, bottom: 0 });
  });
});

it("does not highlight a target that remains fully clipped after scrolling", () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const clip = document.createElement("div");
  clip.style.overflow = "hidden";
  clip.getBoundingClientRect = () => new DOMRect(0, 0, 200, 30);
  Object.defineProperties(clip, {
    clientWidth: { value: 200 },
    clientHeight: { value: 30 },
  });
  const button = document.createElement("button");
  button.getBoundingClientRect = () => new DOMRect(10, 80, 44, 44);
  button.scrollIntoView = vi.fn();
  clip.append(button);
  document.body.append(clip);
  const { result, unmount } = renderHook(() =>
    useLiveRect(() => button, "step"),
  );
  expect(result.current).toBeNull();
  unmount();
  clip.remove();
});

it("tracks the visual viewport when a mobile keyboard opens or shifts it", () => {
  const viewport = Object.assign(new EventTarget(), {
    width: 390,
    height: 844,
    scale: 1,
    offsetLeft: 0,
    offsetTop: 0,
  });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 844);
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(390);
  const { result } = renderHook(() => useViewport());
  expect(result.current).toMatchObject({
    height: 844,
    width: 390,
    offsetLeft: 0,
    rightOffset: 0,
    offsetTop: 0,
    bottomOffset: 0,
  });
  act(() => {
    viewport.height = 400;
    viewport.offsetTop = 30;
    viewport.dispatchEvent(new Event("resize"));
  });
  expect(result.current).toMatchObject({
    height: 400,
    offsetTop: 30,
    bottomOffset: 414,
  });
  act(() => {
    viewport.offsetTop = 40;
    viewport.dispatchEvent(new Event("scroll"));
  });
  expect(result.current).toMatchObject({ offsetTop: 40, bottomOffset: 404 });
  act(() => {
    viewport.width = 195;
    viewport.scale = 2;
    viewport.offsetLeft = 50;
    viewport.dispatchEvent(new Event("resize"));
  });
  expect(result.current).toMatchObject({
    width: 195,
    scale: 2,
    offsetLeft: 50,
    rightOffset: 145,
  });
  act(() => {
    viewport.offsetLeft = 75;
    viewport.dispatchEvent(new Event("scroll"));
  });
  expect(result.current).toMatchObject({ offsetLeft: 75, rightOffset: 120 });
});

it("scrolls a returning target into view once without following later scrolling", () => {
  let nextFrame: FrameRequestCallback = () => {};
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const button = document.createElement("button");
  const scroll = vi.fn();
  button.scrollIntoView = scroll;
  document.body.append(button);
  let target: HTMLElement | null = null;
  const { unmount } = renderHook(() => useLiveRect(() => target, "step"));
  const frame = () => act(() => nextFrame(0));

  target = button;
  frame();
  expect(scroll).toHaveBeenCalledOnce();
  frame();
  expect(scroll).toHaveBeenCalledOnce();
  target = null;
  frame();
  target = button;
  frame();
  expect(scroll).toHaveBeenCalledTimes(2);
  unmount();
  button.remove();
});
