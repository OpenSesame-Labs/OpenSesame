/** @vitest-environment jsdom */
import { cleanup, renderHook } from "@testing-library/react";
import type { NavigateOptions, To } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { useVaultLanding } from "./app-root-hooks.js";
import {
  clearNewGuestLanding,
  markNewGuestLanding,
} from "./lib/guest-landing.js";

afterEach(() => {
  cleanup();
  clearNewGuestLanding();
});

it("leaves an old item URL once when a new guest vault opens", () => {
  const navigate =
    vi.fn<(to: To | number, options?: NavigateOptions) => void>();
  const { rerender } = renderHook(
    ({ status, path }) => useVaultLanding(status, true, path, navigate),
    { initialProps: { status: "empty", path: "/vault/old-item/edit" } },
  );
  markNewGuestLanding();
  rerender({ status: "unlocked", path: "/vault/old-item/edit" });
  expect(navigate).toHaveBeenCalledWith("/vault", { replace: true });
  vi.mocked(navigate).mockClear();
  rerender({ status: "unlocked", path: "/vault/another-item" });
  expect(navigate).not.toHaveBeenCalled();
});

it("preserves item links on ordinary unlock and lands the root on the vault", () => {
  const navigate =
    vi.fn<(to: To | number, options?: NavigateOptions) => void>();
  const { rerender } = renderHook(
    ({ path }) => useVaultLanding("unlocked", false, path, navigate),
    { initialProps: { path: "/vault/kept-item" } },
  );
  expect(navigate).not.toHaveBeenCalled();
  rerender({ path: "/" });
  expect(navigate).toHaveBeenCalledWith("/vault", { replace: true });
});

it.each(["/settings/item-types", "/vault/new/account", "/vault/health"])(
  "keeps a new guest's link to %s",
  (path) => {
    const navigate =
      vi.fn<(to: To | number, options?: NavigateOptions) => void>();
    markNewGuestLanding();
    renderHook(() => useVaultLanding("unlocked", true, path, navigate));
    expect(navigate).not.toHaveBeenCalled();
  },
);
