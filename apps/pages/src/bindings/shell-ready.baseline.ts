/**
 * Main-branch gate behavior before #2607 (regression reference only).
 * Do not import from product code.
 */
import type { EffectivePlan } from "@opensesame/capability-composition";

export type ShellReadyBaselineInput = {
  status: string;
  tomb?: string;
  plan: EffectivePlan | null;
  compositionGeneration: number;
  activatedGeneration: number;
  openedVault: string | null | undefined;
};

/** Pre-fix: a stale `openedVault` latch still mounts the shell after the plan resolves. */
export function computeShellReadyBaseline(
  input: ShellReadyBaselineInput,
): boolean {
  const vault = input.status === "unlocked" ? (input.tomb ?? null) : undefined;
  const plan = input.plan;
  const ready =
    vault !== undefined &&
    (plan === null ||
      (plan.identity.vaultId === vault &&
        input.activatedGeneration === input.compositionGeneration));
  return ready || (vault !== undefined && input.openedVault === vault);
}
