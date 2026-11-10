/**
 * Guest login — no passkey or password. A provisional Identity session is
 * minted, then a registered-auth claim waits on the notifications bell.
 * Completing that claim POSTs the upstream id_token to Identity so the same
 * principalId is promoted (ADR 0033). The HttpOnly provisional cookie survives
 * the OIDC redirect; browser storage never receives the bearer.
 */

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

import { assertGuestsAllowed } from "./guest-access.js";
import { claimProvisionalHistoryAccounts } from "./history-backups.js";
import {
  GUEST_NOTICE_BODY,
  GUEST_NOTICE_TITLE,
  announceMintedIdentity,
} from "./history-claim-notice.js";
import {
  IdentityError,
  connectProvisional,
  currentSession,
  identityJson,
  identitySeams,
  identitySessionEpoch,
  isRemoteIdentityConfigured,
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

/**
 * Identity answers 409 when this upstream account is already bound to another
 * principal. Nothing the user can retry into — say so instead of leaking a
 * transport-shaped message.
 */
const COLLISION_MESSAGE =
  "That account is already attached to a different OpenSesame identity.";

// Stryker disable all: mutable test seam; behavior is exercised through the exported operations
export const guestAuthDependencies = {
  rebindSession,
  sessionEpoch: identitySessionEpoch,
  connectProvisional,
  resumeSession: () => identitySeams.resumeSession(),
  currentSession,
  isRemoteIdentityConfigured,
  identityJson,
  createGuest: (options?: { resume?: boolean }) =>
    vaultStore.createGuest(options),
  vaultStatus: () => vaultStore.getSnapshot().status,
  loadFederationSession,
  /** Identity installs the directory seed; a minimal vault leaves it undone. */
  ensureDefaultAccess: async (_tomb: string): Promise<void> => {},
};
// Stryker restore all

let inFlightClaim: Promise<void> | null = null;

/**
 * Whether there is an identity service to attach a principal to at all.
 *
 * A static deployment with no Identity API is the common case and a complete
 * one (ADR 0090): a guest session is a local vault, and a federated sign-in is
 * the broker's assertion held on this device. Nothing here is "pending" — a
 * claim or link prompt would name a service that does not exist and read as
 * an error on a deployment that is working exactly as designed.
 */
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

async function openGuestVault(mode: "fresh" | "resume"): Promise<void> {
  // Both guest roads end here, so the operator's switch is enforced here too.
  assertGuestsAllowed();
  // Fresh mints a new principal (`guest-N`); resume only when none survived.
  if (mode === "fresh" || !readGuestSessionPerson())
    await mintGuestSessionPersonLocked();
  await guestAuthDependencies.createGuest({ resume: mode === "resume" });
  await seedGuestAccess();
}

async function continueAsGuestDefault(): Promise<void> {
  await openGuestVault("fresh");
  await claimGuestAuthDefault();
}

/** Unlock on the guest road after lock/reload — same principal, keep claims. */
async function resumeGuestSessionDefault(): Promise<void> {
  await openGuestVault("resume");
  await claimGuestAuthDefault();
}

export type LinkGuestAccountOutcome = { mintedPrincipal: boolean };

async function linkGuestAccountDefault(
  idToken: string,
): Promise<LinkGuestAccountOutcome> {
  let mintedPrincipal = false;
  if (!guestAuthDependencies.currentSession()) {
    // Resume the server-authenticated HttpOnly cookie first — that is the
    // persistent user, reused. Only when no session survived does
    // connecting mint a new provisional principal, and the caller is told
    // so a brand-new identity is never created silently.
    const resumed = await guestAuthDependencies.resumeSession();
    if (!resumed) {
      mintedPrincipal = true;
      await guestAuthDependencies.connectProvisional();
    }
  }
  // The session this link is for. A sign-out or lock while the request is
  // in flight must not be undone by the token the answer carries.
  const epoch = guestAuthDependencies.sessionEpoch();
  const linked = await guestAuthDependencies.identityJson<{
    principalId?: string;
    accessToken?: string;
  }>("/v1/principals/link-identities", {
    method: "POST",
    body: JSON.stringify({ idToken }),
  });
  // The verified identity can belong to a principal that already exists
  // (verified-email join, or the same upstream account returning): the
  // server rebound the session to that principal and issued its token.
  // Stand on it (rebind, not adopt: the cookie already names it), so this
  // device continues as the person it used to be rather
  // than as a provisional minted for the trip — nothing new was created.
  if (linked?.accessToken) {
    mintedPrincipal = false;
    await guestAuthDependencies.rebindSession(linked.accessToken, epoch);
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

/**
 * What `adoptFederatedIdentity` did with the verified identity — the caller
 * (the federation return screen) surfaces this instead of guessing, so a
 * sign-in that could not finish is said out loud rather than swallowed.
 */
export type FederatedAdoptOutcome =
  | { kind: "linked" }
  /**
   * Signed in on this device with no identity service to attach to. Not a
   * failure and not pending: the broker's assertion is the identity here.
   */
  | { kind: "local" }
  | { kind: "pending_link" }
  | { kind: "link_failed"; reason: string };

/**
 * Attach a verified upstream identity to a principal, whatever state this
 * device is in when the browser comes back from the upstream (ADR 0033 §4).
 *
 * Federation establishes *who you are* — it never decrypts the local E2EE
 * vault. On a true first run the vault is therefore created the same ephemeral
 * way "Continue as guest" creates one; sealing it with a passkey, PIN, or
 * password stays a later choice in Settings.
 */
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
      // The user is already inside the app; throwing here would push them back
      // out of a sign-in that, from their side, worked. The verified assertion
      // survives in web storage (federation's `saveSession`), so the bell can
      // retry.
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

/**
 * Land a finished ceremony inside the app, not back on the sign-in screen.
 *
 * A verified sign-in with no vault on this device opens the same ephemeral
 * vault "Continue as guest" would — the session says who you are, and sealing
 * the vault with a passkey, PIN, or password stays a later choice in Settings.
 * A locked vault stays locked: federation never decrypts the local E2EE vault,
 * so the caller keeps its "signed in, now unlock" banner for that case.
 *
 * Returns whether the vault is open afterwards — i.e. whether the person
 * landed in the app.
 */
async function openVaultAfterSignInDefault(): Promise<boolean> {
  if (guestAuthDependencies.vaultStatus() === "empty") {
    await openGuestVault("resume");
  }
  return guestAuthDependencies.vaultStatus() === "unlocked";
}

/**
 * Re-raise the "finish attaching this sign-in" prompt after a reload. Notices
 * are in-memory, so a refresh drops them while the upstream assertion lives on
 * in web storage. The prompt reuses the notifications bell's existing claim
 * button, which restarts sign-in and lands back in `adoptFederatedIdentity`
 * with the vault now open.
 */
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
