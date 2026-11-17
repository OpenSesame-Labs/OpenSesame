/**
 * Whether the unlocked shell may mount (ADR 0130).
 *
 * Unlocking moves the composition to the vault's own generation
 * (`vault:<tomb>`), and the change coordinator answers that by revoking every
 * registration of the generation before — routes, rail sections, shell
 * wrappers — and then activating the approved modules again, one at a time.
 * A shell mounted the moment the vault opens is built from the superseded
 * registrations, so it is torn down while that runs: the wrapper set changes
 * and the whole tree remounts, a route goes missing and its screen unmounts,
 * a rail section goes missing and the shell sends the person to the vault.
 * The browser-local consent popup is the sharpest case — unmounting its
 * screen closes the channel the relying party is waiting on
 * (`local_session_closed`), or drops the port it transferred.
 *
 * So the shell waits, once per unlock, for the plan that names this vault
 * and for that generation's activation pass to finish. After that it stays
 * mounted: a later generation is a real authority change and its own
 * fallbacks (`useDeniedRouteFallback`, the router's) answer it. A store that
 * has not resolved a plan has nothing to wait for, and the wait is bounded
 * (`maxWaitMs`): a module whose import stalls delays its own section, never
 * the whole vault.
 */

import {
  activatedGeneration,
  subscribeActivated,
} from "@opensesame/app-core/lib/capabilities/change.js";
import type { EffectivePlan } from "@opensesame/capability-composition";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useComposition } from "./capabilities.js";

export const shellReadySeams = {
  useComposition,
  activatedGeneration,
  subscribeActivated,
  maxWaitMs: 10_000,
};

const subscribe = (listener: () => void) =>
  shellReadySeams.subscribeActivated(listener);
const read = () => shellReadySeams.activatedGeneration();

export type ShellReadyInput = {
  status: string;
  tomb?: string;
  plan: EffectivePlan | null;
  compositionGeneration: number;
  activatedGeneration: number;
  openedVault: string | null | undefined;
  timedOut?: boolean;
  awaitingPlanActivation?: boolean;
};

/** Pure shell-ready gate (`useShellReady` is the React subscription around this). */
export function computeShellReady(input: ShellReadyInput): boolean {
  const vault = input.status === "unlocked" ? (input.tomb ?? null) : undefined;
  const plan = input.plan;
  const ready =
    vault !== undefined &&
    (plan === null ||
      (plan.identity.vaultId === vault &&
        input.activatedGeneration === input.compositionGeneration));
  const waitedOpen =
    vault !== undefined &&
    input.openedVault === vault &&
    (plan === null ||
      input.timedOut === true ||
      (plan.identity.vaultId === vault &&
        input.awaitingPlanActivation !== true));
  return ready || waitedOpen;
}

export function useShellReady(
  status: string,
  tomb: string | undefined,
): boolean {
  const snapshot = shellReadySeams.useComposition();
  const activated = useSyncExternalStore(subscribe, read, read);
  const vault = status === "unlocked" ? (tomb ?? null) : undefined;
  const plan = snapshot.plan;
  const ready =
    vault !== undefined &&
    (plan === null ||
      (plan.identity.vaultId === vault && activated === snapshot.generation));
  const [opened, setOpened] = useState<string | null | undefined>(undefined);
  const [timedOut, setTimedOut] = useState(false);
  const [awaitingPlanActivation, setAwaitingPlanActivation] = useState(false);
  const previousPlanWasNull = useRef(false);
  useEffect(() => {
    if (vault === undefined) {
      setOpened(undefined);
      setTimedOut(false);
      setAwaitingPlanActivation(false);
    } else if (ready) {
      setOpened(vault);
      setTimedOut(false);
      setAwaitingPlanActivation(false);
    } else if (
      previousPlanWasNull.current &&
      plan !== null &&
      plan.identity.vaultId === vault &&
      !timedOut
    ) {
      setAwaitingPlanActivation(true);
      setOpened(undefined);
    }
    previousPlanWasNull.current = plan === null;
  }, [vault, ready, plan, timedOut]);
  useEffect(() => {
    if (vault === undefined || ready) return;
    const timer = setTimeout(() => {
      setOpened(vault);
      setTimedOut(true);
    }, shellReadySeams.maxWaitMs);
    return () => clearTimeout(timer);
  }, [vault, ready]);
  return computeShellReady({
    status,
    tomb,
    plan,
    compositionGeneration: snapshot.generation,
    activatedGeneration: activated,
    openedVault: opened,
    timedOut,
    awaitingPlanActivation,
  });
}
