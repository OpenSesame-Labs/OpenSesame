import { overlapCast } from "@opensesame/os-domain";
/** The tab keeps its access token in memory; Identity may set an HttpOnly cookie. */

import {
  type BrowserGrant,
  BrowserPairingError,
  clearBrowserPairing,
  currentBrowserGrant,
  pairedHostFetch,
} from "./browser-pairing.js";
import {
  isDeviceIdentityMode,
  isRemoteIdentityConfigured,
  remoteIdentityApi,
  resolveIdentityBase,
} from "./device-identity.js";
import { isLocalOnlyGuest } from "./guest-session-context.js";
import { resumeIdentityCookie } from "./identity-cookie-resume.js";
import {
  cookieAuthenticates,
  identityOriginFor,
  revokeRequest,
} from "./identity-cookie-transport.js";
import { guardedIdentityFetch } from "./identity-fetch.js";
import {
  assertIdentityAdoption,
  assertIdentityEpoch,
  captureIdentityEpoch,
  identityEpochChanged,
} from "./identity-owner-epoch.js";
import {
  type ProvisionalOptions,
  connectProvisionalLocked as connectProvisionalOriginal,
} from "./identity-provisional.js";
import { beginProvisional } from "./identity-provisional-entry.js";

export { inspectIdentityCookie } from "./identity-cookie-transport.js";
export { identityRevocationPending } from "./identity-signout-fence.js";

import {
  clearCookieBinding,
  saveCookieBinding,
} from "./identity-cookie-binding.js";
import {
  type HealthState,
  type ProbeResult,
  probeIdentityPlane,
} from "./identity-probe.js";
import { hasPendingBoundRevocation } from "./identity-revocation-journal.js";
import { restoreBoundRevocations } from "./identity-revocation-journal-queue.js";
import {
  queueIssuerRevocation,
  settleIdentityRevocations,
} from "./identity-revocation-queue.js";
import {
  HostSessionError,
  IdentityError,
  type IdentitySession,
  type Principal,
} from "./identity-session-types.js";
import {
  assertNoPendingSignOut,
  signOutFenceActive,
} from "./identity-signout-fence.js";
import { endIdentitySession } from "./identity-signout-owner.js";
import { proveTokenOwner, readError } from "./identity-token-proof.js";
import { loadSettings } from "./settings.js";
import type { OriginalRemoteCodeHandle } from "./vault/captured-remote-code-data.js";
import type { OriginalCommandDrainRecorder } from "./vault/original-command-retirement-data.js";
import { captureOriginalIdentitySessionCodeData } from "./vault/original-identity-session-code-data.js";

export type { HealthState, IdentitySession, Principal, ProbeResult };
export {
  HostSessionError,
  IdentityError,
  isDeviceIdentityMode,
  isRemoteIdentityConfigured,
  remoteIdentityApi,
};

const IDENTITY_FETCH_MS = 8000;
const PROBE_MS = 4000;

let session: IdentitySession | null = null;
let sessionOwnerEpoch: string | null = null;
type HostSession = BrowserGrant;
let pendingIdentitySession: Promise<IdentitySession> | null = null;
/** A previous tab's cookie authenticates, but its bearer did not survive. */
let orphanCookie = false;
/** Bumped whenever the session is ended, to fence slow session creators. */
let sessionEpoch = 0;
let sessionRevision = 0;
const listeners = new Set<() => void>();

function emit(): void {
  sessionRevision += 1;
  for (const listener of listeners) listener();
}

/** Called whenever the session or the orphan-cookie state changes. */
export function subscribeIdentitySession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a previous tab's cookie still authenticates with no bearer here. */
export function orphanSessionActive(): boolean {
  return orphanCookie;
}

function currentSessionDefault(): IdentitySession | null {
  if (isLocalOnlyGuest()) return null;
  if (
    session &&
    (signOutFenceActive() || identityEpochChanged(sessionOwnerEpoch))
  )
    return null;
  if (session && session.issuerOrigin !== identityOrigin()) return null;
  if (session?.expiresAt && Date.parse(session.expiresAt) <= Date.now()) {
    session = null;
    sessionOwnerEpoch = null;
    clearHostSession();
    // Expiry would otherwise be silent, leaving the rail claiming a session
    // that can no longer act. Emit off-stack because this is also called from
    // inside listeners.
    queueMicrotask(emit);
  }
  return session;
}

export function clearSession(): void {
  session = null;
  sessionOwnerEpoch = null;
  clearHostSession();
  // Fence session creators already in flight.
  sessionEpoch += 1;
  emit();
}

/** Detect an authenticating cookie left by an earlier tab. */
async function probeOrphanSessionDefault(): Promise<boolean> {
  if (session) return false;
  // An unreachable service is not a confirmed orphan.
  setOrphan(await cookieAuthenticates(false));
  return orphanCookie;
}

function setOrphan(next: boolean): void {
  if (orphanCookie === next) return;
  orphanCookie = next;
  emit();
}

/** Revoke the current session and any requested observable cookies. */
function endSessionDefault(options?: { orphan?: boolean }): void {
  endIdentitySession({
    session,
    issuer: session?.issuerOrigin ?? identityOrigin(),
    currentIssuer: identityOrigin,
    orphan: options?.orphan === true,
    clear: () => {
      clearSession();
      setOrphan(false);
    },
    failed: recheckOrphan,
  });
}

/** Never send an old session's proof or bearer to a reconfigured service. */
function queueRevokeForIssuer(
  issuer: string,
  request: () => Promise<Response>,
  failed?: () => Promise<void>,
): void {
  queueIssuerRevocation(issuer, identityOrigin, request, failed);
}

async function recheckOrphan(): Promise<void> {
  if (session) return;
  setOrphan(await cookieAuthenticates(true));
}

export async function settleRevokes(): Promise<void> {
  restoreBoundRevocations(identityOrigin, recheckOrphan);
  await settleIdentityRevocations();
  if (hasPendingBoundRevocation())
    throw new Error("Sign-out did not finish. Try again.");
}

function identityBaseDefault(): string {
  return resolveIdentityBase();
}

const identityOrigin = () => identityOriginFor(identityBase);

function hostBaseDefault(): string {
  return loadSettings().hostApi.replace(/\/$/, "");
}

export function clearHostSession(): void {
  clearBrowserPairing();
}

function hostLocalSessionEligibleDefault(
  hostApi: string = hostBase(),
): boolean {
  return Boolean(hostApi) && currentBrowserGrant(hostApi) !== null;
}

/** Ensure the optional Identity session without changing browser Host authority. */
export async function ensureIdentitySession(): Promise<IdentitySession> {
  const existing = currentSession();
  if (existing) {
    return existing;
  }
  if (!pendingIdentitySession) {
    pendingIdentitySession = connectProvisional();
  }
  const pending = pendingIdentitySession;
  try {
    return await pending;
  } finally {
    if (pendingIdentitySession === pending) pendingIdentitySession = null;
  }
}

/** Reuse an approved tab-owned Host grant without creating authority. */
async function ensureHostSessionDefault(): Promise<HostSession> {
  const active = hostBase() ? currentBrowserGrant(hostBase()) : null;
  if (!active)
    throw new HostSessionError(
      "setup_required",
      "This browser has no approved grant for that action.",
    );
  return active;
}

/** Host requests use only the approved origin/key-bound DPoP grant. */
async function hostFetchDefault(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  await ensureHostSession();
  try {
    return await pairedHostFetch(hostBase(), path, init);
  } catch (error) {
    if (error instanceof BrowserPairingError)
      throw new HostSessionError("setup_required", error.message);
    throw error;
  }
}

/** Fetch against Identity with the current tab's verified session. */
async function identityFetchDefault(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  if (session && !currentSession())
    throw new IdentityError("Finish signing out before signing in again.", 409);
  return guardedIdentityFetch(path, init, currentSession, noteUnauthorized);
}

/** Retire a refused bearer and check whether its cookie remains active. */
function noteUnauthorizedDefault(): void {
  if (!session) return;
  clearSession();
  void recheckOrphan();
}

async function identityJsonDefault<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await identityFetch(path, init);
  if (!res.ok) throw new IdentityError(await readError(res), res.status);
  return overlapCast(await res.json());
}

/** Start a provisional session. This is the anonymous on-ramp the API exposes. */
async function connectProvisionalDefault(
  options?: ProvisionalOptions,
): Promise<IdentitySession> {
  if (session && !currentSession())
    throw new IdentityError("Finish signing out before signing in again.", 409);
  return beginProvisional(options, connectProvisionalLocked, settleRevokes);
}

async function connectProvisionalLocked(
  options: ProvisionalOptions,
  owner: string | null,
): Promise<IdentitySession> {
  const issuer = identityOrigin();
  return connectProvisionalOriginal(options, {
    active: () => session,
    epoch: () => sessionEpoch,
    origin: identityOrigin,
    resume: resumeCookieSession,
    orphan: () => setOrphan(true),
    revoke: (token) => {
      queueRevokeForIssuer(issuer, () => revokeRequest(token, "omit"));
    },
    publish: (next) => {
      sessionOwnerEpoch = owner;
      session = next;
      emit();
    },
  });
}

async function resumeCookieSession(
  check: () => void = () => {},
): Promise<IdentitySession | null> {
  const owner = captureIdentityEpoch();
  const guarded = () => {
    check();
    assertIdentityEpoch(owner);
    assertNoPendingSignOut();
  };
  return resumeIdentityCookie(guarded, {
    epoch: () => sessionEpoch,
    origin: identityOrigin,
    current: () => currentSession(),
    publish: (restored) => {
      sessionOwnerEpoch = owner;
      session = restored;
      setOrphan(false);
      emit();
    },
  });
}

/** Revoke only the previous bearer when adopting a rebound session. */
function standOnRebound(
  token: string,
  principalId: string,
  issuerOrigin: string,
  owner: string | null,
  nextProof?: { sessionId: string; proof: string },
): void {
  const previous =
    session && !session.cookieOnly && session.issuerOrigin === issuerOrigin
      ? session.accessToken
      : undefined;
  const unverifiedBrowserSessions = session?.unverifiedBrowserSessions;
  sessionOwnerEpoch = owner;
  session = {
    principalId,
    accessToken: token,
    adopted: true,
    issuerOrigin,
    unverifiedBrowserSessions,
  };
  // A rebound token belongs to a different server session; the old proof must
  // never be used to adopt that new session across a navigation.
  if (nextProof) saveCookieBinding({ issuerOrigin, principalId, ...nextProof });
  else clearCookieBinding();
  setOrphan(false);
  emit();
  if (previous && previous !== token) {
    queueRevokeForIssuer(issuerOrigin, () => revokeRequest(previous, "omit"));
  }
}

/** Revoke a rebound token if sign-out lands while it is being adopted. */
function refuseEndedSession(
  serverBoundToken?: string,
  issuer = identityOrigin(),
): never {
  if (serverBoundToken) {
    queueRevokeForIssuer(issuer, () => revokeRequest(serverBoundToken, "omit"));
  }
  throw new IdentityError(
    "The session was ended while adopting that token. Try again.",
    409,
  );
}

function refuseHiddenSession(
  rebound: boolean,
  token: string,
  issuer: string,
): void {
  if (session && !currentSession())
    refuseEndedSession(rebound ? token : undefined, issuer);
}

async function adoptTokenDefault(
  accessToken: string,
  rebound = false,
  expectedEpoch?: number,
  nextProof?: { sessionId: string; proof: string },
  check?: () => void,
): Promise<void> {
  const token = accessToken.trim();
  const issuerOrigin = identityOrigin();
  const owner = captureIdentityEpoch();
  const checkOriginal = () =>
    assertIdentityAdoption(owner, check, () =>
      refuseEndedSession(rebound ? token : undefined, issuerOrigin),
    );
  checkOriginal();
  refuseHiddenSession(rebound, token, issuerOrigin);
  if (session?.accessToken === token) return;
  // A rebind names the epoch its link request started in: the session can
  // end while that request is in flight, before this function ever runs.
  const epoch = expectedEpoch ?? sessionEpoch;
  if (sessionEpoch !== epoch)
    refuseEndedSession(rebound ? token : undefined, issuerOrigin);
  const principalId = await proveTokenOwner(token, IDENTITY_FETCH_MS);
  checkOriginal();
  if (sessionEpoch !== epoch || identityOrigin() !== issuerOrigin)
    refuseEndedSession(rebound ? token : undefined, issuerOrigin);
  if (rebound) {
    standOnRebound(token, principalId, issuerOrigin, owner, nextProof);
    return;
  }
  // Only now end what came before, detected orphan or not: a cookie this tab
  // never saw would otherwise keep acting alongside the pasted token.
  endSession();
  const adoptionEpoch = sessionEpoch;
  const adoptionOwner = captureIdentityEpoch();
  await settleRevokes();
  if (sessionEpoch !== adoptionEpoch || identityEpochChanged(adoptionOwner)) {
    // A sign-out landed while the old session's revoke was in flight. The
    // pasted token was never adopted, so drop it server-side too rather than
    // resurrect a credential after the person ended the session.
    queueRevokeForIssuer(issuerOrigin, () => revokeRequest(token, "omit"));
    throw new IdentityError(
      "The session was ended while adopting that token. Try again.",
      409,
    );
  }
  sessionOwnerEpoch = adoptionOwner;
  session = {
    principalId,
    accessToken: token,
    adopted: true,
    issuerOrigin,
    // No horizon: the API issued this token and never told us when it dies.
    // Inventing one would drop a token the API still accepts; a 401 ends it.
  };
  emit();
}

async function fetchPrincipalDefault(): Promise<Principal> {
  return identityJson<Principal>("/v1/principals/me");
}

/** Put a stashed bearer back in this tab after an OIDC round-trip. */
function restoreSessionDefault(
  next: IdentitySession,
  expectedEpoch?: number,
): void {
  if (
    isLocalOnlyGuest() ||
    signOutFenceActive() ||
    (session && !currentSession()) ||
    (expectedEpoch !== undefined && sessionEpoch !== expectedEpoch)
  ) {
    if (!next.cookieOnly)
      queueRevokeForIssuer(next.issuerOrigin, () =>
        revokeRequest(next.accessToken, "omit"),
      );
    throw new IdentityError(
      "The session was ended while finishing sign-in. Sign in again.",
      409,
    );
  }
  // A separately verified sign-in has its own session; an earlier cookie
  // proof must never be attached to it merely because the principal matches.
  sessionOwnerEpoch = captureIdentityEpoch();
  clearCookieBinding();
  session = next;
  setOrphan(false);
  emit();
}

export async function probeIdentityDetailed(): Promise<ProbeResult> {
  return probeIdentityPlane(identityBase, PROBE_MS);
}

async function probeIdentityDefault(): Promise<HealthState> {
  return (await probeIdentityDetailed()).health;
}

export const identitySeams = {
  hasRetainedIdentitySession: () => session !== null,
  hostFetch: hostFetchDefault,
  endSession: endSessionDefault,
  ensureHostSession: ensureHostSessionDefault,
  hostLocalSessionEligible: hostLocalSessionEligibleDefault,
  currentSession: currentSessionDefault,
  probeOrphanSession: probeOrphanSessionDefault,
  identityBase: identityBaseDefault,
  hostBase: hostBaseDefault,
  identityFetch: identityFetchDefault,
  noteUnauthorized: noteUnauthorizedDefault,
  identityJson: identityJsonDefault,
  connectProvisional: connectProvisionalDefault,
  resumeSession: resumeCookieSession,
  adoptToken: adoptTokenDefault,
  rebindSession: (
    accessToken: string,
    expectedEpoch?: number,
    nextProof?: { sessionId: string; proof: string },
    check?: () => void,
  ) => adoptTokenDefault(accessToken, true, expectedEpoch, nextProof, check),
  probeIdentity: probeIdentityDefault,
  fetchPrincipal: fetchPrincipalDefault,
  restoreSession: restoreSessionDefault,
};

export async function hostFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return identitySeams.hostFetch(path, init);
}

export function endSession(options?: { orphan?: boolean }): void {
  identitySeams.endSession(options);
}

export async function ensureHostSession(): Promise<HostSession> {
  return identitySeams.ensureHostSession();
}

export function hostLocalSessionEligible(hostApi?: string): boolean {
  // Resolve hostBase inside the seamed implementation, not here. Evaluating
  // hostBase() as a default argument would still run it after tests replace
  // identitySeams.hostLocalSessionEligible.
  return hostApi === undefined
    ? identitySeams.hostLocalSessionEligible()
    : identitySeams.hostLocalSessionEligible(hostApi);
}

export function currentSession(): IdentitySession | null {
  return identitySeams.currentSession();
}
export async function probeOrphanSession(): Promise<boolean> {
  return identitySeams.probeOrphanSession();
}
export function identityBase(): string {
  return identitySeams.identityBase();
}
export function hostBase(): string {
  return identitySeams.hostBase();
}
export async function identityFetch(
  ...args: Parameters<typeof identityFetchDefault>
): ReturnType<typeof identityFetchDefault> {
  return identitySeams.identityFetch(...args);
}
export function noteUnauthorized(): void {
  identitySeams.noteUnauthorized();
}
export async function identityJson<T>(
  ...args: Parameters<typeof identityJsonDefault>
): Promise<T> {
  return identitySeams.identityJson<T>(...args);
}
export async function connectProvisional(
  options?: ProvisionalOptions,
): Promise<IdentitySession> {
  return identitySeams.connectProvisional(options);
}
export async function adoptToken(accessToken: string): Promise<void> {
  return identitySeams.adoptToken(accessToken);
}
/** Stand on a session the link route rebound to an existing principal. */
export async function rebindSession(
  accessToken: string,
  expectedEpoch?: number,
  nextProof?: { sessionId: string; proof: string },
  check?: () => void,
): Promise<void> {
  return identitySeams.rebindSession(
    accessToken,
    expectedEpoch,
    nextProof,
    check,
  );
}
export async function probeIdentity(): Promise<HealthState> {
  return identitySeams.probeIdentity();
}
export async function fetchPrincipal(): Promise<Principal> {
  return identitySeams.fetchPrincipal();
}

export function restoreSession(
  next: IdentitySession,
  expectedEpoch?: number,
): void {
  identitySeams.restoreSession(next, expectedEpoch);
}

/** Fence value for work that must not restore across a sign-out. */
export function identitySessionEpoch(): number {
  return sessionEpoch;
}

/** Moves on every published session or orphan-cookie change. */
export function identitySessionRevision(): number {
  return sessionRevision;
}

/** Original bearer transport DATA only; the private Store must prove primary/all configured factors. */
export function captureOriginalIdentityCodeData(
  original: () => void,
  drainFailed?: OriginalCommandDrainRecorder,
): OriginalRemoteCodeHandle {
  return captureOriginalIdentitySessionCodeData(
    original,
    () => session,
    () => sessionEpoch,
    drainFailed,
  );
}
