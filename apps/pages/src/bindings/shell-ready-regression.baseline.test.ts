/** @vitest-environment node */

import type { EffectivePlan } from "@opensesame/capability-composition";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  type ShellReadyBaselineInput,
  computeShellReadyBaseline,
} from "./shell-ready.baseline.js";
import { computeShellReady } from "./shell-ready.js";

function planFor(vaultId: string): EffectivePlan {
  return overlapCast({ identity: { vaultId } });
}

const stalePlanInput: ShellReadyBaselineInput = {
  status: "unlocked",
  tomb: "personal",
  plan: planFor("personal"),
  compositionGeneration: 2,
  activatedGeneration: 1,
  openedVault: "personal",
};

describe("shell ready regression vs main baseline", () => {
  it("main baseline incorrectly keeps the shell ready on a stale opened latch", () => {
    expect(computeShellReadyBaseline(stalePlanInput)).toBe(true);
  });

  it("fixed computeShellReady blocks the same stale latch until activation", () => {
    expect(
      computeShellReady({
        ...stalePlanInput,
        awaitingPlanActivation: true,
      }),
    ).toBe(false);
  });
});
