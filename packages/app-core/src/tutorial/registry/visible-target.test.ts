/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPointable, visibleTargetRect } from "./visible-target.js";

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
});
