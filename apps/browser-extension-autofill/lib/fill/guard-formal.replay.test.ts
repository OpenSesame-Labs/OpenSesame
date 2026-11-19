/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { decideFill } from "./guard.js";

describe("autofill gesture formal replay", () => {
  it("refuses fill when the gesture did not come from extension-owned UI", () => {
    const arm = {
      trigger: "navigation",
      origin: "https://example.com",
      armedAt: 0,
    };
    const facts = {
      isTopFrame: true,
      origin: "https://example.com",
      passkeyOffered: false,
      field: {
        kind: "password" as const,
        rect: { left: 0, top: 0, width: 100, height: 20 },
        viewport: { width: 800, height: 600 },
        opacity: 1,
        visibility: "visible",
        hitSelf: true,
        disabled: false,
      },
    };
    const decision = decideFill(arm, facts, 1_000);
    expect(decision.fill).toBe(false);
    if (decision.fill) throw new Error("expected refusal");
    expect(decision.refusal).toBe("untrusted_trigger");
  });
});
