import { isCreatableItemKind } from "@opensesame/app-core/lib/item-kinds.js";
import {
  FIRST_VAULT_PACK_GUIDE,
  FIRST_VAULT_SHELL_GUIDE,
  FIRST_VAULT_SIGNIN_GUIDE,
} from "@opensesame/app-core/tutorial/registry/first-vault-guide.js";
import { useEffect } from "react";
import type { SupportController } from "./session.js";

/** In-memory handoff from the setup gate to the newly opened vault. */
let pending = false;
let pendingSignIn = false;
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

export function continueFirstVaultGuide(): void {
  pending = true;
  for (const listener of [...listeners]) listener();
}

export function takeFirstVaultGuide(): boolean {
  const result = pending;
  pending = false;
  return result;
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
          .startGuide(FIRST_VAULT_SIGNIN_GUIDE, "authored")
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
    const resume = () => {
      queueMicrotask(() => {
        if (active && takeFirstVaultGuide()) {
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
    resume();
    return () => {
      active = false;
      stop();
    };
  }, [controller]);
}
