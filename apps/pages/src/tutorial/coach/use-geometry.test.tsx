/** @vitest-environment jsdom */
import { mountGuideTarget } from "@opensesame/app-core/tutorial/registry/targets.js";
import type { GuideTourView } from "@opensesame/guide-runtime";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCoachLayout } from "./use-coach-layout.js";
import { useLiveRect, useViewport } from "./use-geometry.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
  button.getBoundingClientRect = () => new DOMRect(10, top, 100, 60);
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
  act(() => window.dispatchEvent(new WheelEvent("wheel")));
  top = 100;
  frame();
  expect(scroll).toHaveBeenCalledOnce();
  unmount();
  button.remove();
});

it("repairs a late layout reset until the person scrolls", () => {
  let nextFrame: FrameRequestCallback = () => {};
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("innerWidth", 320);
  vi.stubGlobal("innerHeight", 568);
  let top = 200;
  const button = document.createElement("button");
  button.getBoundingClientRect = () => new DOMRect(10, top, 100, 44);
  const scroll = vi.fn(() => {
    top = 200;
  });
  button.scrollIntoView = scroll;
  document.body.append(button);
  const { unmount } = renderHook(() => useLiveRect(() => button, "step"));
  const frame = () => {
    now += 20;
    act(() => nextFrame(now));
  };

  for (let i = 0; i < 20; i += 1) frame();
  now = 5000;
  const pinch = new Event("touchmove");
  Object.defineProperty(pinch, "touches", { value: [{}, {}] });
  act(() => window.dispatchEvent(pinch));
  act(() => window.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true })));
  top = 600;
  frame();
  expect(scroll).toHaveBeenCalledOnce();
  act(() => window.dispatchEvent(new TouchEvent("touchmove")));
  top = 600;
  frame();
  expect(scroll).toHaveBeenCalledOnce();
  unmount();
  button.remove();
});

it("retries at a bounded rate when layout ignores earlier reveal requests", () => {
  let nextFrame: FrameRequestCallback = () => {};
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("innerWidth", 320);
  vi.stubGlobal("innerHeight", 568);
  let top = 600;
  const button = document.createElement("button");
  button.getBoundingClientRect = () => new DOMRect(10, top, 100, 44);
  const scroll = vi.fn(() => {
    if (scroll.mock.calls.length === 3) top = 200;
  });
  button.scrollIntoView = scroll;
  document.body.append(button);
  const { unmount } = renderHook(() => useLiveRect(() => button, "step"));
  const frame = (time: number) => {
    now = time;
    act(() => nextFrame(now));
  };
  expect(scroll).toHaveBeenCalledOnce();
  frame(249);
  expect(scroll).toHaveBeenCalledOnce();
  frame(250);
  expect(scroll).toHaveBeenCalledTimes(2);
  frame(500);
  expect(scroll).toHaveBeenCalledTimes(3);
  frame(750);
  expect(scroll).toHaveBeenCalledTimes(3);
  unmount();
  button.remove();
});

it("switches semantic recovery targets even when their bounds are identical", async () => {
  const box = () => new DOMRect(20, 20, 44, 44);
  const makeTarget = () => {
    const node = document.createElement("button");
    node.getBoundingClientRect = box;
    document.body.append(node);
    return node;
  };
  const edit = makeTarget();
  edit.setAttribute("data-guide-pepper-recovery", "edit");
  const unbindEdit = mountGuideTarget("item.edit", edit);
  const tour = {
    kind: "point",
    target: "item.editor.save",
    side: "top",
    message: "Save",
    step: 6,
    count: 8,
    action: true,
    degraded: false,
    canBack: true,
  } satisfies GuideTourView;
  const card = { current: null };
  const { result, rerender, unmount } = renderHook(
    ({ enabled }) => useCoachLayout(1, tour, card, enabled),
    { initialProps: { enabled: true } },
  );
  expect(result.current.target).toBe("item.edit");
  rerender({ enabled: false });
  expect(result.current.target).toBe("item.editor.save");
  rerender({ enabled: true });
  const save = makeTarget();
  save.setAttribute("data-guide-pepper-recovery", "save");
  const options = makeTarget();
  const pepper = makeTarget();
  let unbindSave = () => {};
  let unbindOptions = () => {};
  let unbindPepper = () => {};
  act(() => {
    unbindEdit();
    unbindSave = mountGuideTarget("item.editor.save", save);
    unbindOptions = mountGuideTarget("editor.password-options", options);
  });
  await waitFor(() =>
    expect(result.current.target).toBe("editor.password-options"),
  );
  act(() => {
    unbindPepper = mountGuideTarget("editor.pepper-options", pepper);
  });
  await waitFor(() =>
    expect(result.current.target).toBe("editor.pepper-options"),
  );
  act(() => save.removeAttribute("data-guide-pepper-recovery"));
  await waitFor(() => expect(result.current.target).toBe("item.editor.save"));
  unmount();
  unbindSave();
  unbindOptions();
  const generate = makeTarget();
  generate.setAttribute("data-guide-pepper-recovery", "generate");
  const unbindGenerate = mountGuideTarget("editor.generate-password", generate);
  const generation = renderHook(() =>
    useCoachLayout(
      2,
      { ...tour, target: "editor.generate-password" },
      card,
      true,
    ),
  );
  expect(generation.result.current.target).toBe("editor.pepper-options");
  act(() => generate.removeAttribute("data-guide-pepper-recovery"));
  await waitFor(() =>
    expect(generation.result.current.target).toBe("editor.generate-password"),
  );
  generation.unmount();
  unbindGenerate();
  unbindPepper();
  for (const node of [edit, save, options, pepper, generate]) node.remove();
});

it.each(["wheel", "touch", "drag", "keyboard", "tab", "other field"])(
  "respects %s scrolling and resumes for a reopened target or a new step",
  (intent) => {
    let nextFrame: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextFrame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("innerWidth", 320);
    vi.stubGlobal("innerHeight", 568);
    let top = 200;
    const button = document.createElement("button");
    button.getBoundingClientRect = () => new DOMRect(10, top, 100, 44);
    const scroll = vi.fn(() => {
      top = 200;
    });
    button.scrollIntoView = scroll;
    const other = document.createElement("input");
    const coach = document.createElement("div");
    coach.className = "coach";
    document.body.append(button, other, coach);
    let target: HTMLElement | null = button;
    const { rerender, unmount } = renderHook(
      ({ step }) => useLiveRect(() => target, step),
      { initialProps: { step: "one" } },
    );
    const frame = () => act(() => nextFrame(0));
    const move = () =>
      act(() => {
        if (intent === "wheel") window.dispatchEvent(new WheelEvent("wheel"));
        else if (intent === "touch")
          window.dispatchEvent(new TouchEvent("touchmove"));
        else if (intent === "drag") {
          const event = new Event("pointermove", { bubbles: true });
          Object.assign(event, { pointerType: "mouse", buttons: 1 });
          window.dispatchEvent(event);
        } else if (intent === "other field") {
          other.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        } else {
          const key = intent === "tab" ? "Tab" : "PageDown";
          (intent === "tab" ? coach : document.body).dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true }),
          );
        }
      });
    move();
    top = 600;
    frame();
    expect(scroll).not.toHaveBeenCalled();
    target = null;
    frame();
    target = button;
    frame();
    expect(scroll).toHaveBeenCalledOnce();
    move();
    top = 600;
    frame();
    expect(scroll).toHaveBeenCalledOnce();
    rerender({ step: "two" });
    frame();
    expect(scroll).toHaveBeenCalledTimes(2);
    unmount();
    button.remove();
    other.remove();
    coach.remove();
  },
);

it("moves a focused field to the edge when zoom and the keyboard leave little room", () => {
  let nextFrame: FrameRequestCallback = () => {};
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
  let top = 38;
  const field = document.createElement("input");
  field.getBoundingClientRect = () => new DOMRect(0, top, 280, 44);
  const scroll = vi.fn(() => {
    top = 0;
  });
  field.scrollIntoView = scroll;
  document.body.append(field);
  field.focus();
  const { unmount } = renderHook(() => useLiveRect(() => field, "step"));
  expect(scroll).toHaveBeenCalledWith({
    block: "start",
    inline: "nearest",
    behavior: "auto",
  });
  act(() => nextFrame(0));
  expect(scroll).toHaveBeenCalledOnce();
  act(() => field.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  top = 600;
  act(() => nextFrame(0));
  expect(scroll).toHaveBeenCalledTimes(2);
  unmount();
  field.remove();
});
