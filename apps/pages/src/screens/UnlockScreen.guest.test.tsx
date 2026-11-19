/** @vitest-environment jsdom */

import {
  FRESH_GUEST_SIGN_OUT_MESSAGE,
  FRESH_GUEST_STATUS_UNKNOWN_MESSAGE,
} from "@opensesame/app-core/lib/guest-auth.js";
import { guestVaultLabel } from "@opensesame/app-core/lib/local-guest.js";
import { settingsSeams } from "@opensesame/app-core/lib/settings.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectInTray } from "../components/tray.test-support.js";
import { UnlockScreen } from "./UnlockScreen.js";
import { GuestUnlockSwitch } from "./unlock/GuestRoad.js";
import {
  continueAsGuest,
  openSignIn,
  resetUnlockHarness,
  resumeGuestSession,
  userMenuTrigger,
  v,
} from "./unlock-screen-harness.js";

beforeEach(resetUnlockHarness);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("UnlockScreen — guest unlock", () => {
  it("shows the sign-out requirement on the locked-vault guest switch", async () => {
    v.state.status = "locked";
    continueAsGuest.mockRejectedValueOnce(
      new Error(FRESH_GUEST_SIGN_OUT_MESSAGE),
    );
    render(<UnlockScreen />);

    fireEvent.click(
      screen.getByRole("button", { name: "Skip to the guest vault" }),
    );

    await expectInTray(FRESH_GUEST_SIGN_OUT_MESSAGE);
    const action = screen.getByRole("button", { name: "Sign out" });
    expect(action.closest(".gate-notice-seat")).not.toBeNull();
  });

  it("offers a retry beside the notice when the connection cannot be checked", async () => {
    v.state.status = "locked";
    continueAsGuest.mockRejectedValueOnce(
      new Error(FRESH_GUEST_STATUS_UNKNOWN_MESSAGE),
    );
    render(<UnlockScreen />);
    fireEvent.click(
      screen.getByRole("button", { name: "Skip to the guest vault" }),
    );

    await expectInTray(FRESH_GUEST_STATUS_UNKNOWN_MESSAGE);
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry.closest(".gate-notice-seat")).not.toBeNull();
    fireEvent.click(retry);
    await waitFor(() => expect(continueAsGuest).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it.each([
    [FRESH_GUEST_SIGN_OUT_MESSAGE, "Sign out"],
    [FRESH_GUEST_STATUS_UNKNOWN_MESSAGE, "Try again"],
  ])(
    "keeps the recovery action available without a notice seat",
    async (message, label) => {
      continueAsGuest.mockRejectedValueOnce(new Error(message));
      const setError = vi.fn();
      render(
        <GuestUnlockSwitch
          busy={false}
          setBusy={vi.fn()}
          setError={setError}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Skip to the guest vault" }),
      );
      expect(await screen.findByRole("button", { name: label })).toBeTruthy();
      expect(setError).toHaveBeenCalledWith(message);
    },
  );

  it("guest Unlock is one commit on a keyless guest tomb, with no key fields", async () => {
    v.state.status = "empty";
    v.state.tomb = "guest";
    v.state.header = null;
    v.methods = [];
    render(<UnlockScreen />);
    expect(screen.getByRole("heading", { name: "Unlock" })).toBeTruthy();
    expect(
      screen.queryByRole("tab", { name: /Passkey|Password|PIN/i }),
    ).toBeNull();
    expect(screen.queryByLabelText(/password|PIN/i)).toBeNull();
    // Unlock resumes this tomb. A second "Skip to the guest vault" beside it
    // would duplicate guest access (AGENTS.md §5), so the footer link stays off.
    expect(
      screen.queryByRole("button", { name: "Skip to the guest vault" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Continue as guest" }),
    ).toBeNull();
    const unlock = screen.getByRole("button", { name: "Unlock" });
    fireEvent.click(unlock);
    await waitFor(() => expect(resumeGuestSession).toHaveBeenCalledTimes(1));
    expect(continueAsGuest).not.toHaveBeenCalled();
  });

  it("opens saved sign-in choices from a keyless guest and returns to Unlock", async () => {
    v.state.status = "empty";
    v.state.tomb = "guest";
    v.state.header = null;
    v.methods = [];
    const settings = settingsSeams.loadSettings();
    vi.spyOn(settingsSeams, "loadSettings").mockReturnValue({
      ...settings,
      signIn: {
        builtin: false,
        providers: [
          {
            providerId: "byo-identity",
            issuer: "https://identity.example.test",
            clientId: "guest-browser-client",
            label: "Saved BYO Identity",
            connectionId: "idc_guest_browser",
            protocol: "oidc",
          },
        ],
      },
    });
    render(<UnlockScreen />);
    expect(screen.getByRole("heading", { name: "Unlock" })).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Continue with Saved BYO Identity",
      }),
    ).toBeNull();

    openSignIn();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Continue with Saved BYO Identity" }),
    ).toBeTruthy();
    expect(document.querySelector(".unlock__form")).toBeNull();
    expect(resumeGuestSession).not.toHaveBeenCalled();
    expect(v.store.unlock).not.toHaveBeenCalled();

    fireEvent.click(userMenuTrigger());
    fireEvent.click(screen.getByRole("menuitem", { name: guestVaultLabel() }));
    expect(screen.getByRole("heading", { name: "Unlock" })).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Continue with Saved BYO Identity",
      }),
    ).toBeNull();
    expect(screen.queryByLabelText(/password|PIN/i)).toBeNull();
    expect(resumeGuestSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(resumeGuestSession).toHaveBeenCalledTimes(1));
    expect(continueAsGuest).not.toHaveBeenCalled();
    expect(v.store.unlock).not.toHaveBeenCalled();
  });
});
