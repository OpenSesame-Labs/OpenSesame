/** @vitest-environment jsdom */

import { mountGuideTarget } from "@opensesame/app-core/tutorial/registry/targets.js";
import type { GuideTourView } from "@opensesame/guide-runtime";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCoachLayout } from "./use-coach-layout.js";
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

it("guides recovery from an empty copied password through edit and save", async () => {
  const edit = document.createElement("a");
  const save = document.createElement("button");
  const pepper = document.createElement("div");
  const copy = document.createElement("button");
  document.body.append(edit, save, pepper, copy);
  edit.setAttribute("data-guide-pepper-recovery", "edit");
  save.setAttribute("data-guide-pepper-recovery", "save");
  const unbindEdit = mountGuideTarget("item.edit", edit);
  const tour = {
    kind: "point",
    target: "item.copy-generated",
    side: "bottom",
    message: "Copy the password.",
    step: 8,
    count: 8,
    action: true,
    degraded: true,
    canBack: false,
  } satisfies GuideTourView;
  const { result, rerender, unmount } = renderHook(
    ({ enabled }) => useCoachLayout(1, tour, { current: null }, enabled),
    { initialProps: { enabled: true } },
  );
  expect(result.current.target).toBe("item.edit");
  rerender({ enabled: false });
  expect(result.current.target).toBe("item.copy-generated");
  rerender({ enabled: true });
  let unbindSave = () => {};
  let unbindPepper = () => {};
  act(() => {
    unbindEdit();
    save.style.display = "none";
    unbindSave = mountGuideTarget("item.editor.save", save);
    unbindPepper = mountGuideTarget("editor.pepper-options", pepper);
  });
  act(() => {
    save.style.display = "";
    save.setAttribute("data-guide-pepper-recovery", "save");
  });
  await waitFor(() =>
    expect(result.current.target).toBe("editor.pepper-options"),
  );
  act(() => save.removeAttribute("data-guide-pepper-recovery"));
  await waitFor(() => expect(result.current.target).toBe("item.editor.save"));
  let unbindCopy = () => {};
  act(() => {
    unbindSave();
    unbindPepper();
    unbindCopy = mountGuideTarget("item.copy-generated", copy);
  });
  await waitFor(() =>
    expect(result.current.target).toBe("item.copy-generated"),
  );
  unmount();
  unbindCopy();
  for (const node of [edit, save, pepper, copy]) node.remove();
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
    const children = [...document.body.children];
    expect(readSafeInsets()).toEqual({ top: 47, bottom: 34 });
    expect([...document.body.children]).toEqual(children);
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

it("refits on keyboard reopen after scrolling the coach, but respects page scrolling", () => {
  let nextFrame: FrameRequestCallback = () => {};
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const viewport = Object.assign(new EventTarget(), {
    width: 320,
    height: 568,
    offsetLeft: 0,
    offsetTop: 0,
  });
  vi.stubGlobal("visualViewport", viewport);
  let top = 300;
  const input = document.createElement("input");
  input.getBoundingClientRect = () => new DOMRect(10, top, 100, 44);
  const scroll = vi.fn(() => {
    top = 40;
  });
  input.scrollIntoView = scroll;
  const coach = document.createElement("div");
  coach.className = "coach";
  document.body.append(input, coach);
  const { unmount } = renderHook(() => useLiveRect(() => input, "pin"));
  const frame = () => act(() => nextFrame(0));
  const swipe = (node: Element) => {
    const event = new Event("touchmove", { bubbles: true });
    Object.defineProperty(event, "touches", { value: [{}] });
    act(() => node.dispatchEvent(event));
  };
  swipe(coach);
  viewport.height = 200;
  act(() => viewport.dispatchEvent(new Event("resize")));
  frame();
  expect(scroll).toHaveBeenCalledOnce();

  viewport.height = 568;
  top = 300;
  act(() => viewport.dispatchEvent(new Event("resize")));
  frame();
  swipe(document.body);
  viewport.height = 200;
  act(() => viewport.dispatchEvent(new Event("resize")));
  frame();
  expect(scroll).toHaveBeenCalledOnce();
  unmount();
  input.remove();
  coach.remove();
});

it("leaves room for a PIN field after focus moves into the coach", () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const viewport = Object.assign(new EventTarget(), {
    width: 160,
    height: 120,
    offsetLeft: 0,
    offsetTop: 60,
  });
  vi.stubGlobal("visualViewport", viewport);
  const input = document.createElement("input");
  input.getBoundingClientRect = () => new DOMRect(10, 98, 100, 44);
  input.scrollIntoView = vi.fn();
  document.body.append(input);
  const { unmount } = renderHook(() => useLiveRect(() => input, "pin"));
  expect(document.activeElement).not.toBe(input);
  expect(input.scrollIntoView).toHaveBeenCalledOnce();
  unmount();
  input.remove();
});

it("does not repeatedly seek impossible clearance in a very short viewport", () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const viewport = Object.assign(new EventTarget(), {
    width: 160,
    height: 95,
    offsetLeft: 0,
    offsetTop: 0,
  });
  vi.stubGlobal("visualViewport", viewport);
  const input = document.createElement("input");
  input.getBoundingClientRect = () => new DOMRect(10, 0, 100, 44);
  input.scrollIntoView = vi.fn();
  document.body.append(input);
  const { unmount } = renderHook(() => useLiveRect(() => input, "pin"));
  expect(input.scrollIntoView).not.toHaveBeenCalled();
  unmount();
  input.remove();
});

it("retries once immediately after a viewport pan, then keeps the retry bounded", () => {
  let nextFrame: FrameRequestCallback = () => {};
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const viewport = Object.assign(new EventTarget(), {
    width: 160,
    height: 120,
    offsetLeft: 0,
    offsetTop: 0,
  });
  vi.stubGlobal("visualViewport", viewport);
  const input = document.createElement("input");
  input.getBoundingClientRect = () => new DOMRect(10, 98, 100, 44);
  input.scrollIntoView = vi.fn();
  document.body.append(input);
  input.focus();
  const { unmount } = renderHook(() => useLiveRect(() => input, "pin"));
  expect(input.scrollIntoView).toHaveBeenCalledOnce();
  viewport.offsetTop = 60;
  act(() => viewport.dispatchEvent(new Event("scroll")));
  now = 16;
  act(() => nextFrame(now));
  expect(input.scrollIntoView).toHaveBeenCalledTimes(2);
  act(() => viewport.dispatchEvent(new Event("scroll")));
  now = 32;
  act(() => nextFrame(now));
  expect(input.scrollIntoView).toHaveBeenCalledTimes(2);
  unmount();
  input.remove();
});
