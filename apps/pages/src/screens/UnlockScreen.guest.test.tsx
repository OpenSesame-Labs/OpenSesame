/** @vitest-environment jsdom */
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
import {
  clearNewGuestLanding,
  takeNewGuestLanding,
} from "../lib/guest-landing.js";
import { UnlockScreen } from "./UnlockScreen.js";
import {
  continueAsGuest,
  openSignIn,
  resetUnlockHarness,
  resumeGuestSession,
  userMenuTrigger,
  v,
} from "./unlock-screen-harness.js";

beforeEach(() => {
  resetUnlockHarness();
  clearNewGuestLanding();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("UnlockScreen — guest unlock", () => {
  it("continues the guest while explaining that its vault items are gone", async () => {
    v.state.status = "empty";
    v.state.tomb = "guest";
    v.state.header = null;
    v.methods = [];
    render(<UnlockScreen />);
    expect(
      screen.getByRole("heading", { name: "Guest vault cleared" }),
    ).toBeTruthy();
    expect(screen.getByText(/guest vault were lost/)).toBeTruthy();
    expect(
      screen.getByText(/guest connections may still be available/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("tab", { name: /Passkey|Password|PIN/i }),
    ).toBeNull();
    expect(screen.queryByLabelText(/password|PIN/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Forgotten how to unlock?" }),
    ).toBeNull();
    // A second guest entry beside this one would duplicate the same action.
    expect(
      screen.queryByRole("button", { name: "Skip to the guest vault" }),
    ).toBeNull();
    const unlock = screen.getByRole("button", {
      name: "Continue as guest",
    });
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
    expect(
      screen.getByRole("heading", { name: "Guest vault cleared" }),
    ).toBeTruthy();
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
    expect(
      screen.getByRole("heading", { name: "Guest vault cleared" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Continue with Saved BYO Identity",
      }),
    ).toBeNull();
    expect(screen.queryByLabelText(/password|PIN/i)).toBeNull();
    expect(resumeGuestSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue as guest" }));
    await waitFor(() => expect(resumeGuestSession).toHaveBeenCalledTimes(1));
    expect(continueAsGuest).not.toHaveBeenCalled();
    expect(v.store.unlock).not.toHaveBeenCalled();
  });

  it("clears the new-session landing if the guest session fails to start", async () => {
    v.state.status = "empty";
    v.state.tomb = "guest";
    v.state.header = null;
    v.methods = [];
    resumeGuestSession.mockRejectedValueOnce(new Error("Guest unavailable"));
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Continue as guest" }));
    await waitFor(() => expect(resumeGuestSession).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Continue as guest" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    await expectInTray("Guest unavailable");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Continue as guest" }),
    );
    expect(takeNewGuestLanding()).toBe(false);
  });
});
