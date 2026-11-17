/** @vitest-environment node */
import { overlapCast } from "@opensesame/os-domain";
import type { EffectivePlan } from "@opensesame/capability-composition";
import { describe, expect, it } from "vitest";
import { computeShellReady } from "./shell-ready.js";

function planFor(vaultId: string): EffectivePlan {
  return overlapCast({ identity: { vaultId } });
}

describe("shell ready fix required", () => {
  it("does not mount the shell on a stale opened latch after the plan resolves", () => {
    expect(
      computeShellReady({
        status: "unlocked",
        tomb: "personal",
        plan: planFor("personal"),
        compositionGeneration: 2,
        activatedGeneration: 1,
        openedVault: "personal",
        awaitingPlanActivation: true,
      }),
    ).toBe(false);
  });
});