import { type VaultHeader, emptyBody } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { defaultPrefs } from "./prefs.js";
import { buildVaultState } from "./store-presentation.js";

const header: VaultHeader = {
  v: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("onboarding recovery formal replay", () => {
  it("does not publish unlocked while the second step is still parked", () => {
    const halfEnrolled = buildVaultState({
      header,
      open: false,
      pending: true,
      ephemeral: false,
      tomb: "personal",
      body: emptyBody(),
      prefs: defaultPrefs,
      attempts: { until: 0, fails: 0 },
    });
    expect(halfEnrolled.status).toBe("locked");
    expect(halfEnrolled.awaitingSecondStep).toBe(true);
    expect(halfEnrolled.status === "unlocked").toBe(false);
  });
});