/** @vitest-environment jsdom */

import {
  forgetGuestContinuation,
  saveGuestContinuation,
} from "@opensesame/app-core/lib/guest-continuation.js";
import { GUEST_RETURN_EXPIRED } from "@opensesame/app-core/lib/guest-signout-copy.js";
import { newGuestVaultId } from "@opensesame/app-core/lib/guest-vault-id.js";
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

function prepareProviderReturn(): () => void {
  v.state.status = "empty";
  v.state.tomb = "guest";
  v.state.header = null;
  v.methods = [];
  const original = window.location.href;
  const token = crypto.randomUUID();
  window.history.replaceState(
    {},
    "",
    `/connections?connection=connection&guest_return=${token}`,
  );
  saveGuestContinuation({
    kind: "vercel",
    token,
    connectionId: "connection",
    tomb: newGuestVaultId(),
    person: { id: `local_${crypto.randomUUID()}`, name: "guest-1" },
    origin: window.location.origin,
    pathname: window.location.pathname,
    deadline: Date.now() + 60_000,
    identity: null,
  });
  return () => {
    forgetGuestContinuation();
    window.history.replaceState({}, "", original);
  };
}

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
      screen.queryByText(/guest’s connections may still be available/),
    ).toBeNull();
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
    expect(unlock.getAttribute("aria-describedby")).toBe("guest-resume-note");
    fireEvent.click(unlock);
    await waitFor(() => expect(resumeGuestSession).toHaveBeenCalledTimes(1));
    expect(continueAsGuest).not.toHaveBeenCalled();
  });

  it("explains the lost temporary items before continuing a provider return", async () => {
    const finish = prepareProviderReturn();
    try {
      render(<UnlockScreen />);
      expect(
        screen.getByText(/temporary vault items did not survive/i),
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", { name: "Continue connection setup" }),
      );
      await waitFor(() => expect(resumeGuestSession).toHaveBeenCalledTimes(1));
    } finally {
      finish();
    }
  });

  it("offers sign-out when a pending provider return cannot be resumed", async () => {
    const finish = prepareProviderReturn();
    resumeGuestSession.mockRejectedValueOnce(new Error(GUEST_RETURN_EXPIRED));
    try {
      render(<UnlockScreen />);
      fireEvent.click(
        screen.getByRole("button", { name: "Continue connection setup" }),
      );
      const signOut = await screen.findByRole("button", {
        name: "Sign out and check",
      });
      expect(
        screen.queryByRole("button", { name: "Continue connection setup" }),
      ).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(signOut));
    } finally {
      finish();
    }
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
