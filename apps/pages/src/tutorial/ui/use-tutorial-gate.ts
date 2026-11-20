/**
 * What a walkthrough needs before it is offered, read the same way by the Ask
 * tab and the Tutorials tabs.
 */

import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { LibraryOptions } from "@opensesame/app-core/tutorial/registry/areas.js";
import { useMemo, useSyncExternalStore } from "react";
import { buildTutorialGateOptions } from "../../lib/tutorial-gate-options.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { useIntegrationsDrawn } from "../../sections/settings/use-integrations-drawn.js";

export function useTutorialGate(): LibraryOptions {
  const integrations = useIntegrationsDrawn();
  const identityApi = useIdentityConfigured();
  const composition = useSyncExternalStore(
    compositionStore.subscribe,
    compositionStore.getSnapshot,
  );
  const vault = useSyncExternalStore(
    vaultStore.subscribe,
    vaultStore.getSnapshot,
  );
  const { status, guest, tomb } = vault;
  // FirstVisitOffer lists this object in an effect. A fresh identity on every
  // render unmounts the card before anyone can answer it. The builder reads
  // the stores these hooks subscribe to; the fields below are when it changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: plan, seal, and drawn integrations are what the builder closes over
  return useMemo(
    () => buildTutorialGateOptions(identityApi),
    [identityApi, integrations, composition.plan, status, guest, tomb],
  );
}
