/** @vitest-environment node */
import type { EffectivePlan } from "@opensesame/capability-composition";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  type ShellReadyInput,
  computeShellReady,
} from "./shell-ready.js";

function planFor(vaultId: string): EffectivePlan {
  return overlapCast({ identity: { vaultId } });
}

/** Mirrors PwaShellReady.tla (computeShellReady parity oracle). */
type TlcPwaState = {
  status: "locked" | "unlocked";
  vault: string;
  planVault: "none" | "personal" | "guest" | "other";
  compGen: number;
  actGen: number;
  opened: 0 | 1 | 2;
  timedOut: boolean;
  awaitingPlanActivation: boolean;
};

function openedVault(
  opened: TlcPwaState["opened"],
  vault: string,
): string | null | undefined {
  if (opened === 0) return undefined;
  if (opened === 1) return null;
  return vault;
}

function tlcComputeReady(state: TlcPwaState): boolean {
  return (
    state.status === "unlocked" &&
    state.planVault === state.vault &&
    state.actGen === state.compGen
  );
}

function tlcWaitedOpen(state: TlcPwaState): boolean {
  return (
    state.status === "unlocked" &&
    state.opened === 2 &&
    (state.planVault === "none" ||
      state.timedOut ||
      (state.planVault === state.vault && !state.awaitingPlanActivation))
  );
}

function tlcShellMounted(state: TlcPwaState): boolean {
  return tlcComputeReady(state) || tlcWaitedOpen(state);
}

function tlcToProductInput(state: TlcPwaState): ShellReadyInput {
  const plan =
    state.planVault === "none"
      ? null
      : planFor(state.planVault === "other" ? "guest" : state.planVault);
  return {
    status: state.status,
    tomb: state.status === "unlocked" ? state.vault : undefined,
    plan,
    compositionGeneration: state.compGen,
    activatedGeneration: state.actGen,
    openedVault: openedVault(state.opened, state.vault),
    timedOut: state.timedOut,
    awaitingPlanActivation: state.awaitingPlanActivation,
  };
}

/** Reachable TLC states exercised on the unlock → plan → activation path. */
const tlcTraces: TlcPwaState[] = [
  {
    status: "unlocked",
    vault: "personal",
    planVault: "none",
    compGen: 1,
    actGen: 1,
    opened: 0,
    timedOut: false,
    awaitingPlanActivation: false,
  },
  {
    status: "unlocked",
    vault: "personal",
    planVault: "personal",
    compGen: 2,
    actGen: 1,
    opened: 2,
    timedOut: false,
    awaitingPlanActivation: true,
  },
  {
    status: "unlocked",
    vault: "personal",
    planVault: "personal",
    compGen: 2,
    actGen: 1,
    opened: 0,
    timedOut: false,
    awaitingPlanActivation: false,
  },
  {
    status: "unlocked",
    vault: "personal",
    planVault: "personal",
    compGen: 2,
    actGen: 2,
    opened: 2,
    timedOut: false,
    awaitingPlanActivation: false,
  },
  {
    status: "unlocked",
    vault: "personal",
    planVault: "personal",
    compGen: 3,
    actGen: 2,
    opened: 2,
    timedOut: false,
    awaitingPlanActivation: false,
  },
  {
    status: "unlocked",
    vault: "personal",
    planVault: "personal",
    compGen: 2,
    actGen: 1,
    opened: 2,
    timedOut: true,
    awaitingPlanActivation: true,
  },
];

describe("PWA shell ready formal replay", () => {
  it("does not mount on a transient null plan before activation or timeout", () => {
    expect(
      computeShellReady({
        status: "unlocked",
        tomb: "personal",
        plan: null,
        compositionGeneration: 1,
        activatedGeneration: 1,
        openedVault: undefined,
      }),
    ).toBe(false);
  });

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

  it("TLC traces agree with computeShellReady", () => {
    for (const [index, trace] of tlcTraces.entries()) {
      const input = tlcToProductInput(trace);
      expect(computeShellReady(input), `trace ${index}`).toBe(
        tlcShellMounted(trace),
      );
    }
  });
});