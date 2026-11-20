/**
 * What a walkthrough needs before it is offered, read the same way by the Ask
 * tab and the Tutorials tab.
 */

import type { LibraryOptions } from "@opensesame/app-core/tutorial/registry/areas.js";
import { useMemo } from "react";
import { useComposition } from "../../bindings/capabilities.js";
import { buildTutorialGateOptions } from "../../lib/tutorial-gate-options.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { useIntegrationsDrawn } from "../../sections/settings/use-integrations-drawn.js";

export function useTutorialGate(): LibraryOptions {
  const { plan } = useComposition();
  const integrations = useIntegrationsDrawn();
  const identityApi = useIdentityConfigured();
  return useMemo(
    () => buildTutorialGateOptions(identityApi),
    [plan, integrations, identityApi],
  );
}