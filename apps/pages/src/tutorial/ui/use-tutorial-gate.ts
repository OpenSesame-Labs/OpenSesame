/**
 * What a walkthrough needs before it is offered, read the same way by the Ask
 * tab and the Tutorials tabs.
 */

import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { LibraryOptions } from "@opensesame/app-core/tutorial/registry/areas.js";
import { useSyncExternalStore } from "react";
import { buildTutorialGateOptions } from "../../lib/tutorial-gate-options.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { useIntegrationsDrawn } from "../../sections/settings/use-integrations-drawn.js";

export function useTutorialGate(): LibraryOptions {
  const integrations = useIntegrationsDrawn();
  const identityApi = useIdentityConfigured();
  useSyncExternalStore(
    compositionStore.subscribe,
    compositionStore.getSnapshot,
  );
  useSyncExternalStore(vaultStore.subscribe, vaultStore.getSnapshot);
  void integrations;
  return buildTutorialGateOptions(identityApi);
}
