import { type VaultHeader, emptyBody } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { defaultPrefs } from "./prefs.js";
import { buildVaultState } from "./store-presentation.js";

/**
 * Shortest TLC path for the BuggyUnlock variant (constant TRUE), which
 * violates PresentationMatchesStore and NoStalePendingWhileOpen.
 * State 6 is the counterexample: the parked key is still set while the
 * vault is open, and the variant reports the second step as waiting.
 * buildVaultState keeps awaitingSecondStep = pending && !open, so that
 * frame does not.
 */
const BUGGY_UNLOCK_TRACE: readonly Frame[] = [
  { action: "Init", header: false, open: false, pending: false },
  { action: "CreateVault", header: true, open: true, pending: false },
  { action: "EnrollSecondStep", header: true, open: true, pending: false },
  { action: "Lock", header: true, open: false, pending: false },
  { action: "PrimaryUnlock", header: true, open: false, pending: true },
  { action: "BuggyUnlockOpen", header: true, open: true, pending: true },
];

type Frame = {
  action: string;
  header: boolean;
  open: boolean;
  pending: boolean;
};

const header: VaultHeader = {
  v: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function present(frame: Frame) {
  return buildVaultState({
    header: frame.header ? header : null,
    open: frame.open,
    pending: frame.pending,
    ephemeral: false,
    tomb: "personal",
    body: emptyBody(),
    prefs: defaultPrefs,
    attempts: { until: 0, fails: 0 },
  });
}

function statusFor(frame: Frame): "empty" | "locked" | "unlocked" {
  if (frame.open) return "unlocked";
  if (frame.header) return "locked";
  return "empty";
}

describe("vault presentation formal replay", () => {
  it("keeps a stale parked key from showing a second step while the vault is open", () => {
    for (const frame of BUGGY_UNLOCK_TRACE) {
      const view = present(frame);
      expect(view.status, frame.action).toBe(statusFor(frame));
      expect(view.awaitingSecondStep, frame.action).toBe(
        frame.pending && !frame.open,
      );
      expect(view.status === "unlocked" && view.awaitingSecondStep).toBe(
        false,
      );
    }

    const stale = BUGGY_UNLOCK_TRACE[5];
    expect(stale?.action).toBe("BuggyUnlockOpen");
    expect(stale?.open).toBe(true);
    expect(stale?.pending).toBe(true);
    const openWithParkedKey = present({
      action: "BuggyUnlockOpen",
      header: true,
      open: true,
      pending: true,
    });
    expect(openWithParkedKey.status).toBe("unlocked");
    expect(openWithParkedKey.awaitingSecondStep).toBe(false);
  });
});
