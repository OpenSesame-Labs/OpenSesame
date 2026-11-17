/** Guest entry, same-tab provider return and explicit session isolation. */

import { federationSessionGeneration } from "./federation-native-session.js";
import { assertGuestsAllowed } from "./guest-access.js";
import { guestAuthDependencies } from "./guest-auth-dependencies.js";
import {
  type GuestContinuation,
  forgetGuestContinuation,
  inspectStoredGuestContinuation,
  peekGuestContinuation,
  requireGuestReturnCleared,
} from "./guest-continuation.js";
import {
  captureGuestReturnSignOutCheck,
  settleGuestReturnSignOut,
} from "./guest-return-signout.js";
import { isLocalOnlyGuest } from "./guest-session-context.js";
import {
  GUEST_NOTICE_BODY,
  GUEST_NOTICE_TITLE,
} from "./history-claim-notice.js";
import { readCookieBinding } from "./identity-cookie-binding.js";
import { RevocationStorageUnavailableError } from "./identity-revocation-journal.js";
import {
  prepareIsolatedGuestPerson,
  readGuestSessionPerson,
} from "./local-guest.js";
import { listNotices, pushNotice, setStatusNotice } from "./notices.js";
import { vaultStore } from "./vault/store.js";

let inFlightClaim: { tomb: string; promise: Promise<void> } | null = null;

/**
 * Whether there is an identity service to attach a principal to at all.
 *
 * A static deployment with no Identity API is the common case and a complete
 * one (ADR 0090): a guest session is a local vault, and a federated sign-in is
 * the broker's assertion held on this device. Nothing here is "pending" — a
 * claim or link prompt would name a service that does not exist and read as
 * an error on a deployment that is working exactly as designed.
 */
export function hasIdentityService(): boolean {
  return guestAuthDependencies.isRemoteIdentityConfigured();
}

export async function claimGuestAuthDefault(check?: () => void): Promise<void> {
  if (!hasIdentityService()) return;
  if (!check && listNotices().some((notice) => notice.kind === "guest_claim")) {
    return;
  }
  const tomb = vaultStore.activeTomb();
  if (inFlightClaim?.tomb === tomb) return inFlightClaim.promise;
  const promise = (async () => {
    try {
      check?.();
      await guestAuthDependencies.connectProvisional(
        check ? { fresh: true, check } : undefined,
      );
      pushNotice({
        kind: "guest_claim",
        title: GUEST_NOTICE_TITLE,
        body: GUEST_NOTICE_BODY,
      });
    } catch (caught) {
      // A concurrent account transition must stop guest entry, not become an
      // offline notice while that account remains usable by the new guest.
      check?.();
      pushNotice({
        kind: "guest_claim",
        title: GUEST_NOTICE_TITLE,
        body:
          caught instanceof Error
            ? `Your guest session is ready. Sign in when Identity is available: ${caught.message}`
            : "Your guest session is ready. Use notifications to sign in when you are ready.",
      });
    }
  })().finally(() => {
    if (inFlightClaim?.promise === promise) inFlightClaim = null;
  });
  inFlightClaim = { tomb, promise };
  return promise;
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

export async function openGuestVault(
  mode: "fresh" | "resume",
  check?: () => void,
  localOnly = false,
): Promise<void> {
  await settleGuestReturnSignOut();
  const signOutCheck = captureGuestReturnSignOutCheck();
  const active = () => {
    signOutCheck();
    requireGuestReturnCleared(localOnly);
    check?.();
  };
  // Both guest roads end here, so the operator's switch is enforced here too.
  assertGuestsAllowed();
  // Ordinary sign-in opens a fresh actor. Only a verified provider return
  // may reuse the actor and tomb saved for that exact continuation.
  const guestPerson = await prepareIsolatedGuestPerson();
  active();
  await guestAuthDependencies.createGuest(
    {
      resume: mode === "resume",
      guestPerson,
      localOnly,
    },
    active,
  );
  const openedTomb = vaultStore.activeTomb();
  try {
    active();
    await seedGuestAccess();
    active();
  } catch (error) {
    if (vaultStore.isUnlocked() && vaultStore.activeTomb() === openedTomb)
      vaultStore.lock();
    throw error;
  }
}

export async function continueAsGuestDefault(): Promise<void> {
  assertGuestsAllowed();
  const { check, localOnly } = await requireFreshGuest();
  await openGuestVault("fresh", check, localOnly);
  const openedTomb = vaultStore.activeTomb();
  if (isLocalOnlyGuest()) {
    setStatusNotice({
      id: "guest.local-only",
      tone: "warn",
      title: "Local-only guest",
      body: "Existing browser sign-ins may still be active. This vault is local only; sign out and start a new guest session to connect services.",
    });
    return;
  }
  const checkGuest = () => {
    check();
    if (!guestAuthDependencies.guestOwnerIsCurrent(openedTomb))
      throw new Error("The guest session ended. Start again.");
  };
  try {
    await claimGuestAuthDefault(checkGuest);
  } catch (error) {
    if (vaultStore.isUnlocked() && vaultStore.activeTomb() === openedTomb)
      vaultStore.lock();
    throw error;
  }
}

function continuationPerson(continuation: GuestContinuation) {
  const person = readGuestSessionPerson();
  if (
    !person ||
    person.id !== continuation.person.id ||
    person.name !== continuation.person.name
  )
    throw new Error(GUEST_RETURN_EXPIRED);
  const binding =
    continuation.identity &&
    readCookieBinding(continuation.identity.issuerOrigin);
  if (
    continuation.identity &&
    (!binding ||
      binding.principalId !== continuation.identity.principalId ||
      binding.sessionId !== continuation.identity.sessionId)
  )
    throw new Error(GUEST_RETURN_EXPIRED);
  return person;
}

/** Unlock on the guest road after lock/reload — same principal, keep claims. */
export async function resumeGuestSessionDefault(): Promise<void> {
  assertGuestsAllowed();
  await settleGuestReturnSignOut();
  const signOutCheck = captureGuestReturnSignOutCheck();
  const continuation = peekGuestContinuation();
  if (!continuation) return continueAsGuestDefault();
  const person = continuationPerson(continuation);
  const epoch = guestAuthDependencies.sessionEpoch();
  let revision = guestAuthDependencies.sessionRevision();
  const federationGeneration = federationSessionGeneration();
  const previous = guestAuthDependencies.currentSession();
  if (
    previous &&
    (!continuation.identity ||
      previous.principalId !== continuation.identity.principalId ||
      previous.issuerOrigin !== continuation.identity.issuerOrigin)
  )
    throw new Error(GUEST_SIGN_OUT_FIRST);
  const check = () => {
    signOutCheck();
    if (
      guestAuthDependencies.sessionEpoch() !== epoch ||
      guestAuthDependencies.sessionRevision() !== revision ||
      federationSessionGeneration() !== federationGeneration ||
      guestAuthDependencies.currentSession() !== previous ||
      peekGuestContinuation()?.token !== continuation.token
    )
      throw new Error(GUEST_RETURN_EXPIRED);
  };
  check();
  await guestAuthDependencies.createGuest(
    {
      resume: true,
      sessionTomb: continuation.tomb,
      guestPerson: person,
      guestReturn: continuation,
    },
    check,
  );
  forgetGuestContinuation(continuation.tomb);
  const stillGuest = () => {
    signOutCheck();
    if (
      !guestAuthDependencies.guestOwnerIsCurrent(continuation.tomb) ||
      guestAuthDependencies.sessionEpoch() !== epoch ||
      guestAuthDependencies.sessionRevision() !== revision ||
      guestAuthDependencies.currentSession() !== previous ||
      federationSessionGeneration() !== federationGeneration
    )
      throw new Error(GUEST_RETURN_EXPIRED);
  };
  try {
    stillGuest();
    await seedGuestAccess();
    stillGuest();
    if (continuation.identity && !previous) {
      const restored = await guestAuthDependencies.resumeSession(stillGuest);
      if (
        restored &&
        (restored.principalId !== continuation.identity.principalId ||
          !restored.cookieOnly)
      )
        throw new Error(GUEST_RETURN_EXPIRED);
      revision = guestAuthDependencies.sessionRevision();
    }
    if (
      continuation.identityExpected &&
      !guestAuthDependencies.currentSession()
    ) {
      setStatusNotice({
        id: "guest.identity-sign-in-again",
        tone: "warn",
        title: "Sign in again",
        body: "Your browser did not keep the remote sign-in during the connection. Sign in again to use connected services.",
        transient: true,
      });
    }
  } catch (error) {
    if (guestAuthDependencies.guestOwnerIsCurrent(continuation.tomb))
      vaultStore.lock();
    throw error;
  }
}

export {
  GUEST_SIGN_OUT_FIRST,
  GUEST_SIGN_OUT_UNVERIFIED,
} from "./guest-signout-copy.js";

import {
  GUEST_RETURN_EXPIRED,
  GUEST_SIGN_OUT_FIRST,
  GUEST_SIGN_OUT_UNVERIFIED,
} from "./guest-signout-copy.js";

async function requireFreshGuest(): Promise<{
  check: () => void;
  localOnly: boolean;
}> {
  await settleGuestReturnSignOut();
  const remote = hasIdentityService();
  let localOnly = false;
  if (inspectStoredGuestContinuation().kind === "unavailable") {
    if (remote) throw new Error(GUEST_SIGN_OUT_UNVERIFIED);
    localOnly = true;
  }
  try {
    await guestAuthDependencies.settleRevokes();
  } catch (error) {
    if (!(error instanceof RevocationStorageUnavailableError)) throw error;
    if (remote) throw new Error(GUEST_SIGN_OUT_UNVERIFIED);
    localOnly = true;
  }
  const epoch = guestAuthDependencies.sessionEpoch();
  const federationGeneration = federationSessionGeneration();
  const check = () => {
    requireGuestReturnCleared(localOnly);
    if (
      guestAuthDependencies.sessionEpoch() !== epoch ||
      federationSessionGeneration() !== federationGeneration ||
      guestAuthDependencies.currentSession() ||
      guestAuthDependencies.hasRetainedIdentitySession() ||
      guestAuthDependencies.loadFederationSession() ||
      guestAuthDependencies.hasHostSession()
    )
      throw new Error(GUEST_SIGN_OUT_FIRST);
  };
  check();
  if (remote) {
    const binding = guestAuthDependencies.inspectSavedIdentityBinding();
    if (binding === "present") throw new Error(GUEST_SIGN_OUT_FIRST);
    if (binding === "unavailable") throw new Error(GUEST_SIGN_OUT_UNVERIFIED);
    const cookie = await guestAuthDependencies.inspectIdentityCookie();
    check();
    if (cookie === "present") throw new Error(GUEST_SIGN_OUT_FIRST);
    if (cookie === "unknown") throw new Error(GUEST_SIGN_OUT_UNVERIFIED);
  }
  if (!localOnly) guestAuthDependencies.clearCookieBinding();
  return { check, localOnly };
}
