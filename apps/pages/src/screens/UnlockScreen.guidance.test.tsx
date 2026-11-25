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
    expect(v.store.createWithPin).not.toHaveBeenCalled();
    // Leaving the field takes the guidance with it; nothing is left behind.
    chooseSealMethod("Passkey");
    expect(screen.queryByText(/sequential run of digits/)).toBeNull();
    expect(statusNotices()).toEqual([]);
  });

  it("reports only whether each PIN step is ready", () => {
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
    const confirm = screen.getByLabelText("Confirm PIN");
    const ready = (input: HTMLElement) =>
      input.getAttribute("data-guide-pin-ready");
    expect(ready(pin)).toBe("false");
    expect(ready(confirm)).toBe("false");
    fireEvent.change(pin, { target: { value: "12345678" } });
    expect(ready(pin)).toBe("false");
    fireEvent.change(pin, { target: { value: "48291037" } });
    expect(ready(pin)).toBe("true");
    expect(ready(confirm)).toBe("false");
    fireEvent.change(confirm, { target: { value: "48291038" } });
    expect(ready(confirm)).toBe("false");
    expect(confirm.getAttribute("aria-invalid")).toBe("true");
    const hint = screen.getByText("PINs do not match.");
    expect(confirm.getAttribute("aria-describedby")).toBe(hint.id);
    fireEvent.change(confirm, { target: { value: "48291037" } });
    expect(ready(confirm)).toBe("true");
    expect(confirm.hasAttribute("aria-invalid")).toBe(false);
    expect(screen.queryByText("PINs do not match.")).toBeNull();
    fireEvent.change(pin, { target: { value: "48291038" } });
    expect(ready(confirm)).toBe("false");
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
