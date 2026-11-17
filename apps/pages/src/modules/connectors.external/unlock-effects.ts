/**
 * What an unlock picks back up for external connectors (moved here from
 * `App.tsx`'s `useAfterUnlock`): a connector directory synced during setup
 * that waited for a vault to seal it (ADR 0115), and a staged or sealed
 * Vercel Connect bearer that arms the live transport. Both are no-ops with
 * nothing outstanding, and both stop the moment the lease or the effect's
 * own signal aborts — a capability disabled mid-flight seals nothing more.
 */

import type { UnlockEffectContribution } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { sealPendingConnectorDirectory } from "@opensesame/app-core/lib/connector-directory.js";
import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import {
  disarmVercelConnectAuth,
  hydrateVercelConnectAuth,
} from "@opensesame/app-core/lib/vercel-connect-session.js";
import { anySignal, runUnlessAborted } from "../signals.js";

/** Test seam: the sealing calls, swappable without a module mock. */
export const connectorUnlockSeams = {
  sealPendingConnectorDirectory,
  hydrateVercelConnectAuth,
  disarmVercelConnectAuth,
};

export function connectorUnlockEffects(
  lease: AbortSignal,
): UnlockEffectContribution[] {
  return [
    {
      id: "seal-connector-directory",
      run: ({ tomb, guest, signal }) => {
        const scope = anySignal([lease, signal]);
        return runUnlessAborted(scope, async () => {
          // A guest tomb is wiped on lock, so it gets the list without
          // taking it: the sync still waits for the vault that lasts.
          await connectorUnlockSeams
            .sealPendingConnectorDirectory(tomb, { ephemeral: guest })
            .catch(() => {
              if (!scope.aborted)
                setStatusNotice({
                  id: "connector-directory-save",
                  tone: "warn",
                  title: "Connector import not saved",
                  body: "The connector directory could not be saved. Try importing it again from Connections.",
                });
            });
        });
      },
    },
    {
      id: "hydrate-vercel-connect",
      run: ({ tomb, guest, signal }) => {
        const scope = anySignal([lease, signal]);
        // The live bearer belongs to this unlock: a lock, a switch to
        // another vault or the capability's end takes it out of memory. The
        // sealed record stays in the tomb for the next unlock.
        scope.addEventListener(
          "abort",
          () => connectorUnlockSeams.disarmVercelConnectAuth(),
          { once: true },
        );
        return runUnlessAborted(scope, async () => {
          // A sealed token arms the live transport, and a staged one lands
          // with the first open tomb.
          await connectorUnlockSeams
            .hydrateVercelConnectAuth(tomb, { ephemeral: guest, signal: scope })
            .catch(() => {
              if (!scope.aborted)
                setStatusNotice({
                  id: "connector-auth-save",
                  tone: "warn",
                  title: "Connection not saved",
                  body: "The connection could not be restored. Try connecting it again from Connections.",
                });
            });
        });
      },
    },
  ];
}
