import { isCreatableItemKind } from "@opensesame/app-core/lib/item-kinds.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  FIRST_VAULT_PACK_GUIDE,
  FIRST_VAULT_SHELL_GUIDE,
  firstVaultSignInGuide,
} from "@opensesame/app-core/tutorial/registry/first-vault-guide.js";
import { useEffect } from "react";
import type { SupportController } from "./session.js";

/** In-memory handoff from the setup gate to the newly opened vault. */
let pending = false;
let pendingSignIn = false;
let pendingGateSteps = 8;
const gateStepsByController = new WeakMap<SupportController, number>();
const listeners = new Set<() => void>();

export function firstVaultSignInPending(route: string): boolean {
  return route === "/unlock/signin" && pendingSignIn;
}

function firstVaultTarget(controller: SupportController): string | null {
  const guide = controller.view().guide;
  return guide?.goal === "gate.front-door"
    ? (guide.tour?.target ?? null)
    : null;
}

export function continueFirstVaultGuide(gateSteps = 8): void {
  pending = true;
  pendingGateSteps = gateSteps;
  for (const listener of [...listeners]) listener();
}

/** An unlocked vault owes no sign-in continuation: the ceremony completed. */
export function clearFirstVaultSignInHandoff(): void {
  pendingSignIn = false;
}

/** Drops every owed first-vault continuation. Lock and tests call this. */
export function resetFirstVaultHandoff(): void {
  pending = false;
  pendingSignIn = false;
  pendingGateSteps = 8;
}

function takeFirstVaultSteps(): number | null {
  if (!pending) return null;
  pending = false;
  const result = pendingGateSteps;
  pendingGateSteps = 8;
  return result;
}

export function takeFirstVaultGuide(): boolean {
  return takeFirstVaultSteps() !== null;
}

/** Completed gate steps for the first-vault guide on this controller. */
export function firstVaultGateSteps(controller: SupportController): number {
  return gateStepsByController.get(controller) ?? 8;
}

function subscribeFirstVaultGuide(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Setup can replace the gate's support controller as capabilities activate. */
export function preserveFirstVaultGate(
  controller: SupportController,
  unlocked = false,
): void {
  const target = firstVaultTarget(controller);
  if (
    !unlocked &&
    (target === "setup.default" || target === "unlock.local-only")
  ) {
    pendingSignIn = true;
  }
  controller.destroy();
}

export function useFirstVaultGateHandoff(
  controller: SupportController,
  route: string | null,
): void {
  useEffect(() => {
    if (route !== "/unlock/signin") return;
    let active = true;
    const acknowledge = () => {
      if (firstVaultTarget(controller) === "unlock.local-only") {
        pendingSignIn = false;
      }
    };
    const stop = controller.subscribe(acknowledge);
    queueMicrotask(() => {
      if (!active || !pendingSignIn) return;
      // Setup can replace the controller again while its guide engine loads.
      // Keep the handoff available until the replacement publishes its guide.
      acknowledge();
      if (pendingSignIn) {
        void controller
          .startGuide(firstVaultSignInGuide(), "authored")
          .finally(() => {
            if (active) pendingSignIn = false;
          });
      }
    });
    return () => {
      active = false;
      stop();
    };
  }, [controller, route]);
}
export function useFirstVaultHandoff(controller: SupportController): void {
  useEffect(() => {
    let active = true;
    // A vault that locks again before the continuation ran owes nothing: the
    // first-vault walk restarts from the gate the next time around.
    const stopLock = vaultStore.onLock(() => {
      resetFirstVaultHandoff();
    });
    const resume = () => {
      queueMicrotask(() => {
        if (!active) return;
        const gateSteps = takeFirstVaultSteps();
        if (gateSteps !== null) {
          gateStepsByController.set(controller, gateSteps);
          void controller.startGuide(
            isCreatableItemKind("account")
              ? FIRST_VAULT_SHELL_GUIDE
              : FIRST_VAULT_PACK_GUIDE,
            "authored",
          );
        }
      });
    };
    const stop = subscribeFirstVaultGuide(resume);
    const stopGuide = controller.subscribe(() => {
      const guide = controller.view().guide;
      if (
        guide !== null &&
        (guide.goal !== "gate.front-door" || guide.status === "done")
      ) {
        gateStepsByController.delete(controller);
      }
    });
    resume();
    return () => {
      active = false;
      stop();
      stopGuide();
      stopLock();
    };
  }, [controller]);
}
