/** @vitest-environment jsdom */
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inTray } from "../components/tray.test-support.js";
import { UnlockScreen } from "./UnlockScreen.js";
import {
  ANSWERED,
  chooseSealMethod,
  goLocalOnly,
  resetUnlockHarness,
  setupHolder,
  submitButton,
  v,
} from "./unlock-screen-harness.js";

const statusNotices = () => listNotices().filter((n) => n.kind === "status");

beforeEach(resetUnlockHarness);
afterEach(cleanup);

describe("UnlockScreen — guidance is drawn in the page, not trayed", () => {
  it("binds the first-vault guide to the PIN controls a person can use", () => {
    setupHolder.current = ANSWERED;
    v.state = {
      status: "empty",
      header: null,
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingSecondStep: false,
    };
    v.methods = ["password"];
    v.host = { ok: true };
    render(<UnlockScreen />);
    goLocalOnly();
    const pinTab = screen.getByRole("tab", { name: "PIN" });
    expect(pinTab.getAttribute("data-guide-targets")).toContain(
      "unlock.seal-pin",
    );
    expect(
      pinTab.closest('[data-guide-targets~="unlock.methods"]'),
    ).not.toBeNull();
    chooseSealMethod("PIN");
    expect(
      screen.getByLabelText("Device PIN").getAttribute("data-guide-targets"),
    ).toContain("unlock.seal-pin-entry");
    expect(
      screen.getByLabelText("Confirm PIN").getAttribute("data-guide-targets"),
    ).toContain("unlock.seal-pin-confirm");
    expect(
      screen
        .getByLabelText("I understand this vault cannot be recovered.")
        .closest("label")
        ?.getAttribute("data-guide-targets"),
    ).toContain("unlock.seal-ack");
    expect(submitButton().getAttribute("data-guide-targets")).toContain(
      "unlock.seal",
    );
  });

  it("names the PIN format problem live beside the field on first run", () => {
    setupHolder.current = ANSWERED;
    v.state = {
      status: "empty",
      header: null,
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingSecondStep: false,
    };
    v.methods = ["password"];
    v.host = { ok: true };
    render(<UnlockScreen />);
    goLocalOnly();
    chooseSealMethod("PIN");
    const pin = screen.getByLabelText("Device PIN");
    const confirmation = screen.getByLabelText("Confirm PIN");
    expect(pin.getAttribute("data-guide-next-blocked")).toBe("true");
    expect(confirmation.getAttribute("data-guide-next-blocked")).toBe("true");
    fireEvent.change(screen.getByLabelText("Device PIN"), {
      target: { value: "12345678" },
    });
    const hint = screen.getByText(/sequential run of digits/);
    expect(hint.className).toBe("hint");
    expect(inTray("sequential run of digits")).toBe(false);
    expect(statusNotices()).toEqual([]);
    expect(
      screen.getByLabelText("Device PIN").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(
      document.querySelector('[role="alert"]:not(.visually-hidden)'),
    ).toBeNull();
    fireEvent.click(
      screen.getByLabelText("I understand this vault cannot be recovered."),
    );
    fireEvent.change(screen.getByLabelText("Confirm PIN"), {
      target: { value: "12345678" },
    });
    expect(submitButton().disabled).toBe(true);
    expect(pin.getAttribute("data-guide-next-blocked")).toBe("true");
    fireEvent.change(pin, { target: { value: "13579246" } });
    expect(pin.getAttribute("data-guide-next-blocked")).toBeNull();
    expect(confirmation.getAttribute("data-guide-next-blocked")).toBe("true");
    fireEvent.change(confirmation, { target: { value: "13579246" } });
    expect(confirmation.getAttribute("data-guide-next-blocked")).toBeNull();
    fireEvent.change(pin, { target: { value: "24681357" } });
    expect(confirmation.getAttribute("data-guide-next-blocked")).toBe("true");
    expect(v.store.createWithPin).not.toHaveBeenCalled();
    // Leaving the field takes the guidance with it; nothing is left behind.
    chooseSealMethod("Passkey");
    expect(screen.queryByText(/sequential run of digits/)).toBeNull();
    expect(statusNotices()).toEqual([]);
  });

  it("says so in the page when a vault has an authenticator code but no key", () => {
    setupHolder.current = ANSWERED;
    v.state = {
      ...v.state,
      status: "locked",
      header: { unlocks: { totp: {} } },
    };
    v.methods = [];
    render(<UnlockScreen />);
    const note = screen.getByText("No key opens it.");
    expect(note.className).toBe("hint");
    expect(statusNotices()).toEqual([]);
    expect(screen.queryByRole("tab", { name: "Password" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Unlock/ })).toBeNull();
    // The roads that still work stay: the guest tomb, and deleting to seal again.
    expect(
      screen.getByRole("button", { name: "Skip to the guest vault" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Continue as guest" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Forgotten how to unlock?" }),
    ).toBeTruthy();
  });
});
