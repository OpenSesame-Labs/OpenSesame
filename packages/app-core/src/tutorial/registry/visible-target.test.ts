/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPointable,
  revealVisibleTarget,
  visibleTargetRect,
} from "./visible-target.js";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a tutorial target's visibility", () => {
  it("rejects controls hidden by an ancestor", () => {
    const parent = document.createElement("div");
    const button = document.createElement("button");
    parent.append(button);
    document.body.append(parent);
    parent.setAttribute("aria-hidden", "true");
    expect(isPointable(button)).toBe(false);
    parent.removeAttribute("aria-hidden");
    parent.style.opacity = "0";
    expect(isPointable(button)).toBe(false);
  });

  it("clips the highlight to the visible portion inside a scrollport", () => {
    const parent = document.createElement("div");
    const button = document.createElement("button");
    parent.style.overflowY = "auto";
    parent.append(button);
    document.body.append(parent);
    vi.spyOn(parent, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 100, 300, 200),
    );
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
      new DOMRect(30, 280, 44, 44),
    );
    Object.defineProperty(parent, "clientHeight", { value: 200 });
    expect(visibleTargetRect(button)).toEqual({
      left: 30,
      top: 280,
      right: 74,
      bottom: 300,
      width: 44,
      height: 20,
    });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
      new DOMRect(30, 310, 44, 44),
    );
    expect(visibleTargetRect(button)).toBeNull();
  });

  it("clips to the visual viewport when the on-screen keyboard shifts it", () => {
    vi.stubGlobal("visualViewport", {
      offsetLeft: 0,
      offsetTop: 200,
      width: 390,
      height: 300,
    });
    const button = document.createElement("button");
    document.body.append(button);
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
      new DOMRect(20, 180, 44, 50),
    );
    expect(visibleTargetRect(button)).toEqual({
      left: 20,
      top: 200,
      right: 64,
      bottom: 230,
      width: 44,
      height: 30,
    });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
      new DOMRect(20, 510, 44, 44),
    );
    expect(visibleTargetRect(button)).toBeNull();
  });

  it("does not repeatedly scroll a clipped target and notices manual reveal", () => {
    const clip = document.createElement("div");
    clip.style.overflow = "hidden";
    clip.getBoundingClientRect = () => new DOMRect(0, 0, 100, 50);
    Object.defineProperties(clip, {
      clientWidth: { value: 100 },
      clientHeight: { value: 50 },
    });
    const button = document.createElement("button");
    let top = 100;
    button.getBoundingClientRect = () => new DOMRect(10, top, 44, 44);
    button.scrollIntoView = vi.fn();
    clip.append(button);
    document.body.append(clip);
    const attempted = new WeakSet<HTMLElement>();
    expect(revealVisibleTarget([button], attempted)).toBe(false);
    expect(revealVisibleTarget([button], attempted)).toBe(false);
    expect(button.scrollIntoView).toHaveBeenCalledOnce();
    top = 2;
    expect(revealVisibleTarget([button], attempted)).toBe(true);
    expect(button.scrollIntoView).toHaveBeenCalledOnce();
  });

  it("does not count a target that becomes hidden during reveal", () => {
    const button = document.createElement("button");
    let top = 2_000;
    button.getBoundingClientRect = () => new DOMRect(10, top, 44, 44);
    button.scrollIntoView = () => {
      top = 10;
      button.style.display = "none";
    };
    document.body.append(button);
    expect(revealVisibleTarget([button], new WeakSet())).toBe(false);
  });
});
