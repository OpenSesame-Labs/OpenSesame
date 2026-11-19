/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLiveRect, useViewport } from "./use-geometry.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("tracks the visual viewport when a mobile keyboard opens or shifts it", () => {
  const viewport = Object.assign(new EventTarget(), {
    width: 390,
    height: 844,
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
    viewport.offsetLeft = 50;
    viewport.dispatchEvent(new Event("resize"));
  });
  expect(result.current).toMatchObject({
    width: 195,
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

it("reveals a clipped target after a resize without following later scrolling", () => {
  let nextFrame: FrameRequestCallback = () => {};
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("innerWidth", 400);
  vi.stubGlobal("innerHeight", 300);
  let top = 100;
  const button = document.createElement("button");
  button.getBoundingClientRect = () =>
    ({
      left: 10,
      right: 110,
      top,
      bottom: top + 60,
      width: 100,
      height: 60,
      x: 10,
      y: top,
      toJSON() {},
    }) as DOMRect;
  const scroll = vi.fn(() => {
    top = 20;
  });
  button.scrollIntoView = scroll;
  document.body.append(button);
  const { unmount } = renderHook(() => useLiveRect(() => button, "step"));
  const frame = () => act(() => nextFrame(0));

  vi.stubGlobal("innerHeight", 120);
  act(() => window.dispatchEvent(new Event("resize")));
  frame();
  expect(scroll).toHaveBeenCalledOnce();
  for (let i = 0; i < 16; i += 1) frame();
  top = 100;
  frame();
  expect(scroll).toHaveBeenCalledOnce();
  unmount();
  button.remove();
});
