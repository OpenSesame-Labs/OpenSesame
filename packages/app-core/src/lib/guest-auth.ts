/** Guest entry and identity claim; the bearer stays in memory (ADR 0033). */

import {
  clearPendingLink,
  markPendingLink,
  pendingLinkMarked,
} from "./federated-pending-link.js";
import { loadSession as loadFederationSession } from "./federation.js";

export {
  forgetPendingLink,
  storedKeyPresent,
} from "./federated-pending-link.js";

import { resolveIdentityBase } from "./device-identity.js";
import { assertGuestsAllowed } from "./guest-access.js";
import { claimProvisionalHistoryAccounts } from "./history-backups.js";
import {
  GUEST_NOTICE_BODY,
  GUEST_NOTICE_TITLE,
  announceMintedIdentity,
} from "./history-claim-notice.js";
import {
  IdentityError,
  connectFreshProvisional,
  connectProvisional,
  currentSession,
  hostLocalSessionEligible,
  identityJson,
  identitySeams,
  identitySessionEpoch,
  isRemoteIdentityConfigured,
  orphanSessionActive,
  rebindSession,
} from "./identity.js";
import {
  mintGuestSessionPersonLocked,
  readGuestSessionPerson,
} from "./local-guest.js";
import { clearNotices, listNotices, pushNotice } from "./notices.js";
import { vaultStore } from "./vault/store.js";

const FEDERATED_NOTICE_TITLE = "Finish attaching your sign-in";
const FEDERATED_NOTICE_BODY =
  "You are signed in, but this device's vault was locked so the account was not attached yet. Unlock the vault, then finish from here.";

/** A 409 means the upstream identity belongs to another principal. */
const COLLISION_MESSAGE =
  "That account is already attached to a different OpenSesame identity.";

export const FRESH_GUEST_SIGN_OUT_MESSAGE =
  "Sign out of the current account first, then continue as a fresh guest.";
export const FRESH_GUEST_STATUS_UNKNOWN_MESSAGE =
  "Check your connection, then try again.";

// Stryker disable all: mutable test seam; behavior is exercised through the exported operations
export const guestAuthDependencies = {
  rebindSession,
  sessionEpoch: identitySessionEpoch,
  connectProvisional,
  connectFreshProvisional,
  resumeSession: () => identitySeams.resumeSession(),
  currentSession,
  /** An approved Host grant this device would act under. */
  hasHostSession: () => hostLocalSessionEligible(),
  /** A previous tab's Identity cookie that still authenticates, unseen here. */
  hasHiddenIdentitySession: orphanSessionActive,
  isRemoteIdentityConfigured,
  identityJson,
  createGuest: (options?: { resume?: boolean }) =>
    vaultStore.createGuest(options),
  vaultStatus: () => vaultStore.getSnapshot().status,
  loadFederationSession,
  mintGuestPerson: mintGuestSessionPersonLocked,
  /** Identity installs the directory seed; a minimal vault leaves it undone. */
  ensureDefaultAccess: async (_tomb: string): Promise<void> => {},
};
// Stryker restore all

let inFlightClaim: Promise<void> | null = null;

/** A local-only deployment has no remote identity to claim (ADR 0090). */
function hasIdentityService(): boolean {
  return guestAuthDependencies.isRemoteIdentityConfigured();
}

async function claimGuestAuthDefault(): Promise<void> {
  if (!hasIdentityService()) return;
  if (listNotices().some((notice) => notice.kind === "guest_claim")) {
    return;
  }
  if (inFlightClaim) return inFlightClaim;
  inFlightClaim = (async () => {
    try {
      await guestAuthDependencies.connectProvisional();
      pushNotice({
        kind: "guest_claim",
        title: GUEST_NOTICE_TITLE,
        body: GUEST_NOTICE_BODY,
      });
    } catch (caught) {
      pushNotice({
        kind: "guest_claim",
        title: GUEST_NOTICE_TITLE,
        body:
          caught instanceof Error
            ? `Continue as guest succeeded. Claim auth when Identity is reachable — ${caught.message}`
            : "Continue as guest succeeded. Claim auth from the notifications bell when you want a registered sign-in.",
      });
    }
  })().finally(() => {
    inFlightClaim = null;
  });
  return inFlightClaim;
}

async function seedGuestAccess(): Promise<void> {
  try {
    // Seed the tomb this guest session actually unlocked — always the guest
    // isolation tomb after createGuest, never a member vault.
    await guestAuthDependencies.ensureDefaultAccess(vaultStore.activeTomb());
  } catch {
    /* Access seeds when Identity/Access opens; guest entry must not fail. */
  }
}

function assertNoKnownRemoteSession(expectedPrincipalId?: string): void {
  const active = guestAuthDependencies.currentSession();
  if (
    (active && active.principalId !== expectedPrincipalId) ||
    guestAuthDependencies.loadFederationSession() ||
    guestAuthDependencies.hasHostSession() ||
    guestAuthDependencies.hasHiddenIdentitySession()
  ) {
    throw new Error(FRESH_GUEST_SIGN_OUT_MESSAGE);
  }
}

async function openGuestVault(
  mode: "fresh" | "resume",
  freshAdmission = false,
  expectedPrincipalId?: string,
): Promise<void> {
  // Both guest roads end here, so the operator's switch is enforced here too.
  assertGuestsAllowed();
  // Fresh mints a new principal (`guest-N`); resume only when none survived.
  if (mode === "fresh" || !readGuestSessionPerson()) {
    await guestAuthDependencies.mintGuestPerson(
      freshAdmission
        ? () => assertNoKnownRemoteSession(expectedPrincipalId)
        : undefined,
    );
  }
  await guestAuthDependencies.createGuest({ resume: mode === "resume" });
  await seedGuestAccess();
}

async function continueAsGuestDefault(): Promise<void> {
  // A fresh guest must not reuse a local or remote session; resume keeps its person.
  const principalId = await establishFreshGuestIdentity();
  await openGuestVault("fresh", true, principalId);
  await claimGuestAuthDefault();
}

/** Unlock on the guest road after lock/reload — same principal, keep claims. */
async function resumeGuestSessionDefault(): Promise<void> {
  const fresh = !readGuestSessionPerson();
  const principalId = fresh ? await establishFreshGuestIdentity() : undefined;
  await openGuestVault("resume", fresh, principalId);
  await claimGuestAuthDefault();
}

async function establishFreshGuestIdentity(): Promise<string | undefined> {
  assertNoKnownRemoteSession();
  if (!hasIdentityService()) return undefined;
  const session = await guestAuthDependencies.connectFreshProvisional();
  assertNoKnownRemoteSession(session.principalId);
  return session.principalId;
}

export type LinkGuestAccountOutcome = { mintedPrincipal: boolean };

async function linkGuestAccountDefault(
  idToken: string,
): Promise<LinkGuestAccountOutcome> {
  let mintedPrincipal = false;
  if (!guestAuthDependencies.currentSession()) {
    // Resume the cookie first; report if a new principal had to be minted.
    const resumed = await guestAuthDependencies.resumeSession();
    if (!resumed) {
      mintedPrincipal = true;
      await guestAuthDependencies.connectProvisional();
    }
  }
  // The session this link is for. A sign-out or lock while the request is
  // in flight must not be undone by the token the answer carries.
  const epoch = guestAuthDependencies.sessionEpoch();
  const issuerBase = resolveIdentityBase();
  const linked = await guestAuthDependencies.identityJson<{
    principalId?: string;
    accessToken?: string;
  }>("/v1/principals/link-identities", {
    method: "POST",
    body: JSON.stringify({ idToken }),
  });
  // Rebind to the existing principal; the cookie already names its token.
  if (linked?.accessToken) {
    mintedPrincipal = false;
    await guestAuthDependencies.rebindSession(
      linked.accessToken,
      epoch,
      issuerBase,
    );
  }
  const principalId =
    linked?.principalId ?? guestAuthDependencies.currentSession()?.principalId;
  if (principalId) {
    try {
      await claimProvisionalHistoryAccounts(principalId);
    } catch {
      /* history claim is best-effort beside identity link */
    }
  }
  clearNotices();
  return { mintedPrincipal };
}

/** A 409 from link-identities is the only outcome with its own plain words. */
function describeLinkFailure(caught: Error | null): string {
  if (caught instanceof IdentityError && caught.status === 409) {
    return COLLISION_MESSAGE;
  }
  return caught instanceof Error
    ? caught.message
    : "Attaching the account failed.";
}

/** Outcome surfaced by the federation return screen. */
export type FederatedAdoptOutcome =
  | { kind: "linked" }
  /** Local sign-in with no remote identity service. */
  | { kind: "local" }
  | { kind: "pending_link" }
  | { kind: "link_failed"; reason: string };

/** Attach verified identity without decrypting a locked vault (ADR 0033). */
async function adoptFederatedIdentityDefault(
  idToken: string,
): Promise<FederatedAdoptOutcome> {
  const status = guestAuthDependencies.vaultStatus();

  if (!hasIdentityService()) {
    // No principal to link to, so nothing to defer or retry. A true first run
    // still opens the same ephemeral vault a guest gets; a locked vault stays
    // locked, and the caller's "signed in, now unlock" banner says so.
    if (status === "empty") await openGuestVault("resume");
    const federation = guestAuthDependencies.loadFederationSession();
    if (federation?.pairwiseSub) {
      try {
        await claimProvisionalHistoryAccounts(federation.pairwiseSub);
      } catch {
        /* history claim is best-effort beside local federation */
      }
    }
    clearPendingLink();
    return { kind: "local" };
  }

  if (status === "empty") {
    await openGuestVault("resume");
    try {
      const { mintedPrincipal } = await linkGuestAccountDefault(idToken);
      if (mintedPrincipal) {
        announceMintedIdentity();
      }
      clearPendingLink();
      return { kind: "linked" };
    } catch (caught) {
      // Preserve the sign-in and offer the failed link for retry.
      const reason = describeLinkFailure(
        caught instanceof Error ? caught : null,
      );
      markPendingLink();
      pushNotice({
        kind: "guest_claim",
        title: GUEST_NOTICE_TITLE,
        body: `Signed in on this device. Attach the account when Identity is reachable — ${reason}`,
      });
      return { kind: "link_failed", reason };
    }
  }

  if (status === "locked" && !guestAuthDependencies.currentSession()) {
    // Minting a provisional principal here would bind this identity to a
    // throwaway — and if it is already bound to the real principal behind the
    // locked vault, Identity answers 409 and the link could never be made.
    markPendingLink();
    pushNotice({
      kind: "federated_link",
      title: FEDERATED_NOTICE_TITLE,
      body: FEDERATED_NOTICE_BODY,
    });
    return { kind: "pending_link" };
  }

  await linkToOpenVault(idToken);
  clearPendingLink();
  return { kind: "linked" };
}

/** Attach to the principal behind the open vault; a collision says so plainly. */
async function linkToOpenVault(idToken: string): Promise<void> {
  try {
    const { mintedPrincipal } = await linkGuestAccountDefault(idToken);
    if (mintedPrincipal) announceMintedIdentity();
  } catch (caught) {
    if (caught instanceof IdentityError && caught.status === 409) {
      throw new Error(COLLISION_MESSAGE);
    }
    throw caught;
  }
}

/** Open an empty vault after sign-in; federation never unlocks a sealed vault. */
async function openVaultAfterSignInDefault(): Promise<boolean> {
  if (guestAuthDependencies.vaultStatus() === "empty") {
    await openGuestVault("resume");
  }
  return guestAuthDependencies.vaultStatus() === "unlocked";
}

/** Restore the pending-link notice after a reload. */
function recoverPendingFederatedLinkDefault(): void {
  if (!pendingLinkMarked()) return;
  if (!guestAuthDependencies.loadFederationSession()) {
    // Expired, or the issuer's trust was withdrawn: nothing left to finish.
    clearPendingLink();
    return;
  }
  if (listNotices().some((notice) => notice.kind === "federated_link")) return;
  pushNotice({
    kind: "federated_link",
    title: FEDERATED_NOTICE_TITLE,
    body: FEDERATED_NOTICE_BODY,
  });
}

export const guestAuthSeams = {
  continueAsGuest: continueAsGuestDefault,
  resumeGuestSession: resumeGuestSessionDefault,
  claimGuestAuth: claimGuestAuthDefault,
  linkGuestAccount: linkGuestAccountDefault,
  adoptFederatedIdentity: adoptFederatedIdentityDefault,
  openVaultAfterSignIn: openVaultAfterSignInDefault,
  recoverPendingFederatedLink: recoverPendingFederatedLinkDefault,
};

export async function continueAsGuest(): Promise<void> {
  return guestAuthSeams.continueAsGuest();
}

export async function resumeGuestSession(): Promise<void> {
  return guestAuthSeams.resumeGuestSession();
}

export async function claimGuestAuth(): Promise<void> {
  return guestAuthSeams.claimGuestAuth();
}

export async function linkGuestAccount(
  idToken: string,
): Promise<LinkGuestAccountOutcome> {
  return guestAuthSeams.linkGuestAccount(idToken);
}

export async function adoptFederatedIdentity(
  idToken: string,
): Promise<FederatedAdoptOutcome> {
  return guestAuthSeams.adoptFederatedIdentity(idToken);
}

export async function openVaultAfterSignIn(): Promise<boolean> {
  return guestAuthSeams.openVaultAfterSignIn();
}

export function recoverPendingFederatedLink(): void {
  guestAuthSeams.recoverPendingFederatedLink();
}
