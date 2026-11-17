/** @vitest-environment jsdom */
import { overlapCast } from "@opensesame/os-domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expectInTray } from "../components/tray.test-support.js";
import { UnlockScreen } from "./UnlockScreen.js";
import {
  resetUnlockHarness,
  submitButton,
  v,
} from "./unlock-screen-harness.js";

beforeEach(resetUnlockHarness);

describe("UnlockScreen — PIN unlock", () => {
  beforeEach(() => {
    v.state = {
      status: "locked",
      header: null,
      lockedOutUntil: null,
      failedAttempts: 0,
      durable: true,
      awaitingSecondStep: false,
    };
    v.methods = ["password", "pin"];
    v.preferred = "password";
    v.host = { ok: true };
    for (const fn of Object.values(v.store)) fn.mockReset();
    v.store.unlockWithPin.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("switches to the PIN tab and unlocks with the PIN", async () => {
    render(<UnlockScreen />);
    const tab = screen.getByRole("tab", { name: "PIN" });
    expect(tab.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(tab);
    expect(tab.getAttribute("aria-selected")).toBe("true");

    const pin = overlapCast<unknown, HTMLInputElement>(
      screen.getByLabelText("PIN"),
    );
    fireEvent.change(pin, { target: { value: "123" } });
    expect(submitButton().disabled).toBe(true);
    fireEvent.change(pin, { target: { value: "12345678" } });
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(v.store.unlockWithPin).toHaveBeenCalledWith("12345678"),
    );
    await waitFor(() => expect(pin.value).toBe(""));
  });

  it("shows PIN failures", async () => {
    v.store.unlockWithPin.mockRejectedValue(new Error("bad PIN"));
    render(<UnlockScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "PIN" }));
    fireEvent.change(screen.getByLabelText("PIN"), {
      target: { value: "12345678" },
    });
    fireEvent.click(submitButton());
    await expectInTray("bad PIN");
  });
});
