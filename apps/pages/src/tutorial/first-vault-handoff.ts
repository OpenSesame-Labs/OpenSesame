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

export function continueFirstVaultGuide(): void {
  pending = true;
  for (const listener of [...listeners]) listener();
}

export function takeFirstVaultGuide(): boolean {
  const result = pending;
  pending = false;
  return result;
}

export function subscribeFirstVaultGuide(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Setup can replace the gate's support controller as capabilities activate. */
export function preserveFirstVaultGate(
  controller: SupportController,
  unlocked = false,
): void {
  const guide = controller.view().guide;
  if (
    !unlocked &&
    guide?.goal === "gate.front-door" &&
    guide.tour?.target === "unlock.local-only"
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
    queueMicrotask(() => {
      if (!active || !pendingSignIn) return;
      pendingSignIn = false;
      void controller.startGuide(FIRST_VAULT_SIGNIN_GUIDE, "authored");
    });
    return () => {
      active = false;
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
