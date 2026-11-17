/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  view: { busy: false, error: "Sign-out is not finished." },
  retry: vi.fn(),
  restore: vi.fn(),
}));
vi.mock("@opensesame/app-core/lib/guest-return-signout.js", () => ({
  guestReturnSignOutSnapshot: () => state.view,
  restoreGuestReturnSignOut: state.restore,
  retryGuestReturnSignOut: state.retry,
  subscribeGuestReturnSignOut: () => () => {},
}));

import { GuestReturnSignOutStatus } from "./GuestReturnSignOutStatus.js";

it("offers an accessible retry when guest sign-out is incomplete", () => {
  render(<GuestReturnSignOutStatus />);
  expect(screen.getByText("Sign-out is not finished.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry guest sign-out" }));
  expect(state.retry).toHaveBeenCalledOnce();
});
