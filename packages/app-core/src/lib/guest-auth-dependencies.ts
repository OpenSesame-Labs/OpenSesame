import { resolveIdentityBase } from "./device-identity.js";
import { loadSession as loadFederationSession } from "./federation.js";
import type { GuestContinuation } from "./guest-continuation.js";
import {
  activeGuestEpoch,
  captureGuestSessionContext,
  isLocalOnlyGuest,
} from "./guest-session-context.js";
import {
  connectProvisional,
  currentSession,
  hostLocalSessionEligible,
  identityJson,
  identitySeams,
  identitySessionEpoch,
  identitySessionRevision,
  inspectIdentityCookie,
  isRemoteIdentityConfigured,
  rebindSession,
  settleRevokes,
} from "./identity.js";
import {
  clearCookieBinding,
  inspectCookieBinding,
} from "./identity-cookie-binding.js";
import { identityOriginFor } from "./identity-cookie-transport.js";
import type { GuestSessionPerson } from "./local-guest.js";
import { vaultStore } from "./vault/store.js";

// Stryker disable all: mutable test seam; behavior is exercised through the exported operations
export const guestAuthDependencies = {
  rebindSession,
  sessionEpoch: identitySessionEpoch,
  sessionRevision: identitySessionRevision,
  inspectIdentityCookie,
  inspectSavedIdentityBinding: () =>
    inspectCookieBinding(identityOriginFor(resolveIdentityBase)).kind,
  settleRevokes,
  clearCookieBinding,
  connectProvisional,
  resumeSession: (check?: () => void) => identitySeams.resumeSession(check),
  currentSession,
  hasRetainedIdentitySession: () => identitySeams.hasRetainedIdentitySession(),
  hasHostSession: () => hostLocalSessionEligible(),
  isRemoteIdentityConfigured,
  identityJson,
  createGuest: (
    options?: {
      resume?: boolean;
      guestPerson?: GuestSessionPerson;
      sessionTomb?: string;
      guestReturn?: GuestContinuation;
      localOnly?: boolean;
    },
    check?: () => void,
  ) => vaultStore.createGuest(options, check),
  guestOwnerIsCurrent: (tomb: string) =>
    vaultStore.isUnlocked() &&
    vaultStore.activeTomb() === tomb &&
    !isLocalOnlyGuest() &&
    activeGuestEpoch() !== null &&
    captureGuestSessionContext()?.() === true,
  vaultStatus: () => vaultStore.getSnapshot().status,
  loadFederationSession,
  ensureDefaultAccess: async (_tomb: string): Promise<void> => {},
};
// Stryker restore all
