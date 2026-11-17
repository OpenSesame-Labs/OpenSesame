/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useShortViewport } from "./use-short-viewport.js";

afterEach(() => vi.unstubAllGlobals());

describe("useShortViewport", () => {
  it("follows visual viewport changes even when the layout viewport stays the same", () => {
    const viewport = Object.assign(new EventTarget(), { height: 844 });
    vi.stubGlobal("visualViewport", viewport);
    const { result } = renderHook(() => useShortViewport());
    expect(result.current).toBe(false);

    act(() => {
      viewport.height = 320;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(true);

    act(() => {
      viewport.height = 844;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(false);
  });
});
