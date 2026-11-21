/**
 * The support capability's part of a gate (ADR 0166): a controller of its own,
 * built with no agent, and the help key in the seat the screen drew.
 *
 * It is drawn beside the screen, not around it (`GateHost`), and it holds no
 * more than the shell's does: the same sheet, the same Tutorials library read
 * through the same gate, the same tour card. What is different is what it is
 * given. The engine is built `offline`, so no agent loader is asked for
 * anything — no on-device model to download, no configured endpoint to send a
 * question to — and the guide runtime is handed a navigator that goes nowhere:
 * a gate has no section to move to, and a tour here may only point and wait.
 * Nothing is written to storage; the transcript is memory, as everywhere.
 */

import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { GuideRuntimeSnapshot } from "@opensesame/guide-runtime";
import { type ReactElement, useEffect, useState } from "react";
import { type SupportHost, loadBrowserEngine } from "../engine.js";
import {
  continueFirstVaultGuide,
  preserveFirstVaultGate,
  useFirstVaultGateHandoff,
} from "../first-vault-handoff.js";
import { useGateRoute } from "../gate-seat.js";
import { createSupportController, supportSessionSeams } from "../session.js";
import { SupportContext } from "../support-context.js";
import { SupportLauncher } from "./SupportLauncher.js";

/** Swapped by tests; the browser wiring is the default. */
export const supportGateSeams = {
  loadEngine: (host: SupportHost) => loadBrowserEngine(host, { offline: true }),
};

/** The route a gate reports until its screen has said which one it is. */
const GATE_ROUTE = "/unlock";
const FIRST_VAULT_SEAL_TARGETS = new Set([
  "unlock.methods",
  "unlock.submit",
  "unlock.seal-actions",
  "unlock.seal-pin-entry",
  "unlock.seal-pin-confirm",
  "unlock.seal-ack",
  "unlock.seal",
]);

/** Keep the handoff armed only inside the live sealing sequence. */
export function firstVaultSealingState(
  armed: boolean,
  guide: GuideRuntimeSnapshot | null,
  unlocked: boolean,
): boolean {
  if (guide?.goal !== "gate.front-door") return false;
  if (unlocked) return armed;
  if (guide.status === "done") return false;
  const target = guide.tour?.target;
  if (target != null) return FIRST_VAULT_SEAL_TARGETS.has(target);
  return armed && guide.status === "waiting";
}

/** Gate setup owns two steps before the replacement sign-in controller. */
export function firstVaultDisplayedGateStep(
  guide: GuideRuntimeSnapshot | null,
): number {
  const tour = guide?.tour;
  if (!tour) return 0;
  return tour.step + (tour.count === 6 ? 2 : 0);
}

export function SupportGate(): ReactElement {
  const route = useGateRoute();
  const [controller] = useState(() =>
    createSupportController({
      ...supportSessionSeams,
      loadEngine: (host) => supportGateSeams.loadEngine(host),
      // The shell's controller wipes every mounted target when the vault locks.
      // A gate's controller is torn down by the unlock itself, in the same
      // commit that mounts the shell, so a wipe here would take the shell's
      // targets with it; the screens' own refs already unmount theirs.
      clearTargets: () => {},
    }),
  );

  useEffect(
    () => () =>
      preserveFirstVaultGate(
        controller,
        vaultStore.getSnapshot().status === "unlocked",
      ),
    [controller],
  );
  useFirstVaultGateHandoff(controller, route);

  useEffect(() => {
    let sealing = false;
    let sealingStep = 0;
    const check = () => {
      const guide = controller.view().guide;
      const unlocked = vaultStore.getSnapshot().status === "unlocked";
      sealing = firstVaultSealingState(sealing, guide, unlocked);
      if (sealing) sealingStep = firstVaultDisplayedGateStep(guide);
      if (unlocked && sealing && guide?.goal === "gate.front-door") {
        sealing = false;
        continueFirstVaultGuide(sealingStep || 8);
      }
    };
    const stopGuide = controller.subscribe(check);
    const stopVault = vaultStore.subscribe(check);
    check();
    return () => {
      stopGuide();
      stopVault();
    };
  }, [controller]);

  // Subscribed here rather than at construction, like the shell's provider, so
  // React discarding a controller in StrictMode leaves no handler behind.
  useEffect(
    () => supportSessionSeams.onLock(() => controller.lock()),
    [controller],
  );

  useEffect(() => {
    controller.setRoute(route ?? GATE_ROUTE);
  }, [controller, route]);

  useEffect(() => {
    controller.setNavigator(() => false);
  }, [controller]);

  return (
    <SupportContext.Provider value={controller}>
      <SupportLauncher gate />
    </SupportContext.Provider>
  );
}
