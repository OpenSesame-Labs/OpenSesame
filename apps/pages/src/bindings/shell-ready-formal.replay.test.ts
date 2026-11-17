/** @vitest-environment node */
import type { EffectivePlan } from "@opensesame/capability-composition";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { computeShellReady } from "./shell-ready.js";

function planFor(vaultId: string): EffectivePlan {
  return overlapCast({ identity: { vaultId } });
}

/** TLC shortest path: unlock with `plan = null`, plan resolves before activation. */
describe("PWA shell ready formal replay", () => {
  it("does not keep the shell open on a stale opened flag after the plan arrives", () => {
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

  it("mounts after activation catches the plan generation", () => {
    expect(
      computeShellReady({
        status: "unlocked",
        tomb: "personal",
        plan: planFor("personal"),
        compositionGeneration: 2,
        activatedGeneration: 2,
        openedVault: "personal",
      }),
    ).toBe(true);
  });

  it("keeps the shell mounted when a later generation is still activating", () => {
    expect(
      computeShellReady({
        status: "unlocked",
        tomb: "personal",
        plan: planFor("personal"),
        compositionGeneration: 3,
        activatedGeneration: 2,
        openedVault: "personal",
        awaitingPlanActivation: false,
      }),
    ).toBe(true);
  });

  it("allows the bounded wait to open without activation", () => {
    expect(
      computeShellReady({
        status: "unlocked",
        tomb: "personal",
        plan: planFor("personal"),
        compositionGeneration: 2,
        activatedGeneration: 1,
        openedVault: "personal",
        timedOut: true,
      }),
    ).toBe(true);
  });
});
