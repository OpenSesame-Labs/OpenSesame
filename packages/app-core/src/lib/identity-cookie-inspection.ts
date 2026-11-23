/** Read-only inspection of the Identity cookie, split out of identity.ts. */
import {
  isDeviceIdentityMode,
  resolveIdentityBase,
} from "./device-identity.js";
import {
  cookieIdentitySession,
  probeIdentityCookie,
} from "./identity-probe.js";
import { revocationPendingFor } from "./identity-revocation-journal.js";
import type { IdentitySession } from "./identity-session-types.js";

export type RemoteIdentitySessionInspection =
  | { kind: "present"; session: IdentitySession }
  | { kind: "absent" }
  | { kind: "unknown" };

export type InspectionState = {
  current(): IdentitySession | null;
  revision(): number;
  origin(): string;
  /** Retire this tab's session if another tab signed out meanwhile. */
  sync(): void;
};

/**
 * Whether the cookie alone names a session, without presenting a bearer. A
 * session changed while the probe was out, a reconfigured service, or a
 * cookie whose revoke is still owed (the ended session, never a new one) all
 * leave the answer unknown rather than present.
 */
export async function inspectIdentityCookieSession(
  state: InspectionState,
  timeoutMs: number,
): Promise<RemoteIdentitySessionInspection> {
  const active = state.current();
  if (active) return { kind: "present", session: active };
  // Device-native identity has no HttpOnly cookie plane.
  if (isDeviceIdentityMode()) return { kind: "absent" };
  const revision = state.revision();
  const base = resolveIdentityBase();
  const result = await probeIdentityCookie(timeoutMs);
  if (resolveIdentityBase() !== base) return { kind: "unknown" };
  state.sync();
  if (revocationPendingFor(base)) return { kind: "unknown" };
  if (state.revision() !== revision) {
    const changed = state.current();
    return changed
      ? { kind: "present", session: changed }
      : { kind: "unknown" };
  }
  if (result.kind !== "present") return result;
  return {
    kind: "present",
    session: cookieIdentitySession(result.principalId, state.origin(), base),
  };
}
