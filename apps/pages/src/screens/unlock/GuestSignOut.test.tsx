/** @vitest-environment jsdom */

import { GUEST_RETURN_EXPIRED } from "@opensesame/app-core/lib/guest-signout-copy.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  inspect: vi.fn<() => Promise<"absent" | "present" | "unknown">>(),
  continuation: vi.fn<() => { kind: "present" | "none" }>(() => ({
    kind: "none",
  })),
  signOut: vi.fn(),
  setStatusNotice: vi.fn(),
  dismissNotice: vi.fn(),
}));
vi.mock("@opensesame/app-core/lib/guest-auth.js", () => ({
  GUEST_SIGN_OUT_FIRST: "Sign out first",
  GUEST_SIGN_OUT_UNVERIFIED: "Sign-out cannot be verified",
}));
vi.mock("@opensesame/app-core/lib/guest-return-signout.js", () => ({
  settleGuestReturnSignOut: async () => {},
}));
vi.mock("@opensesame/app-core/lib/guest-continuation.js", () => ({
  inspectStoredGuestContinuation: dependencies.continuation,
}));
vi.mock("@opensesame/app-core/lib/identity.js", () => ({
  endSession: () => {},
  settleRevokes: async () => {},
  inspectIdentityCookie: dependencies.inspect,
}));
vi.mock("@opensesame/app-core/lib/notices.js", () => ({
  listNotices: () => [],
  setStatusNotice: dependencies.setStatusNotice,
  dismissNotice: dependencies.dismissNotice,
}));
vi.mock("@opensesame/app-core/lib/session-exit.js", () => ({
  signOut: dependencies.signOut,
}));

import { GuestSignOut } from "./GuestSignOut.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  dependencies.continuation.mockReturnValue({ kind: "none" });
});

it("offers verified sign-out after a pending return fails", async () => {
  dependencies.continuation.mockReturnValue({ kind: "present" });
  dependencies.inspect.mockResolvedValue("absent");
  const onDone = vi.fn();
  render(
    <GuestSignOut
      message={GUEST_RETURN_EXPIRED}
      allowPendingReturn
      onDone={onDone}
    />,
  );
  const signOut = screen.getByRole("button", { name: "Sign out and check" });
  expect(document.activeElement).toBe(signOut);
  fireEvent.click(signOut);
  await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  expect(dependencies.signOut).toHaveBeenCalledOnce();
});

it("does not report a completed sign-out when Identity cannot verify it", async () => {
  dependencies.inspect.mockResolvedValue("unknown");
  const onDone = vi.fn();
  render(
    <GuestSignOut message="Sign-out cannot be verified" onDone={onDone} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Sign out and check" }));
  expect(
    await screen.findByRole("img", { name: /could not be verified/i }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(dependencies.setStatusNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "guest.signout",
        body: expect.stringMatching(/could not be verified/i),
      }),
    ),
  );
  expect(onDone).not.toHaveBeenCalled();
});

it("continues only once Identity confirms sign-out", async () => {
  dependencies.inspect.mockResolvedValue("absent");
  const onDone = vi.fn();
  render(<GuestSignOut message="Sign out first" onDone={onDone} />);
  fireEvent.click(screen.getByRole("button", { name: "Sign out and check" }));
  await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
});
