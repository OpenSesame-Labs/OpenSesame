/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLiveRect, useViewport } from "./use-geometry.js";

afterEach(() => vi.unstubAllGlobals());

it("tracks the visual viewport when a mobile keyboard opens or shifts it", () => {
  const viewport = Object.assign(new EventTarget(), {
    height: 844,
    offsetTop: 0,
  });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 844);
  const { result } = renderHook(() => useViewport());
  expect(result.current).toMatchObject({
    height: 844,
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
