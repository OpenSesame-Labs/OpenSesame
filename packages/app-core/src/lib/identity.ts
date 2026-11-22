/** Identity bearers stay in memory; ordinary sessions can use an HttpOnly cookie. */

import {
  type BrowserGrant,
  clearBrowserPairing as clearHostSession,
  fetchApprovedHost,
  hasApprovedHost,
  hostApiBase,
  requireApprovedHostSession,
} from "./browser-pairing.js";
import {
  identityIssuerOrigin,
  identityPlaneRequest,
  isDeviceIdentityMode,
  isRemoteIdentityConfigured,
  remoteIdentityApi,
  resolveIdentityBase,
} from "./device-identity.js";
import {
  type HealthState,
  type ProbeResult,
  clearGuestIsolation,
  cookieAuthenticates,
  cookieIdentitySession,
  guestIsolationActive,
  markGuestIsolation,
  orphanActive,
  probeIdentityCookie,
  probeIdentityPlane,
  updateOrphan,
} from "./identity-probe.js";
import {
  HostSessionError,
  IdentityError,
  type IdentitySession,
  type Principal,
} from "./identity-session-types.js";
import {
  bearerForIssuer,
  flushBearerRevokes,
  mintProvisionalCredential,
  proveTokenOwner,
  queueIdentityRevoke,
  readIdentityJson,
  rememberBearerRevoke,
  rememberForeignSession,
  requireIssuer,
  retryBearerRevokes,
  revokeIdentityRequest,
  settleRevokes,
} from "./identity-token-proof.js";
import type { OriginalRemoteCodeHandle } from "./vault/captured-remote-code-data.js";
import type { OriginalCommandDrainRecorder } from "./vault/original-command-retirement-data.js";
import { captureOriginalIdentitySessionCodeData } from "./vault/original-identity-session-code-data.js";

export { settleRevokes } from "./identity-token-proof.js";
export type { HealthState, IdentitySession, Principal, ProbeResult };
export {
  HostSessionError,
  IdentityError,
  clearHostSession,
  isDeviceIdentityMode,
  isRemoteIdentityConfigured,
  remoteIdentityApi,
};

const IDENTITY_FETCH_MS = 8000;
const PROBE_MS = 4000;
let session: IdentitySession | null = null;
type HostSession = BrowserGrant;
let pendingIdentitySession: Promise<IdentitySession> | null = null;
let guestCookieObserved = "";
/** Bumped whenever the session is ended, to fence slow session creators. */
let sessionEpoch = 0;
let sessionRevision = 0;
const listeners = new Set<() => void>();

function emit(): void {
  sessionRevision += 1;
  for (const listener of listeners) listener();
}

export function subscribeIdentitySession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a previous tab's cookie still authenticates with no bearer here. */
export function orphanSessionActive(): boolean {
  return orphanActive();
}

function currentSessionDefault(): IdentitySession | null {
  if (
    session &&
    (session.issuerOrigin !== identityOrigin() ||
      (session.issuerBase && session.issuerBase !== resolveIdentityBase()))
  ) {
    clearSession();
    return null;
  }
  if (session?.expiresAt && Date.parse(session.expiresAt) <= Date.now()) {
    session = null;
    clearHostSession();
    // Notify off-stack: this can run inside a listener.
    queueMicrotask(emit);
  }
  return session;
}

export function clearSession(): void {
  rememberForeignSession(session, resolveIdentityBase());
  session = null;
  clearHostSession();
  // Fence in-flight work so it cannot resurrect a session after lock.
  sessionEpoch += 1;
  emit();
}

/** Detect an authenticating cookie left behind after the bearer was lost. */
async function probeOrphanSessionDefault(): Promise<boolean> {
  if (session) return false;
  // An unreachable service does not prove an orphan cookie exists.
  const revision = sessionRevision;
  const found = await cookieAuthenticates(false, PROBE_MS);
  if (!session && sessionRevision === revision) setOrphan(found);
  return orphanSessionActive();
}

function setOrphan(next: boolean | null, base = resolveIdentityBase()): void {
  if (updateOrphan(next, base)) emit();
}

/** Revoke both the bearer and any independently authenticating cookie. */
function endSessionDefault(): void {
  // An adopted token has no cookie, so send its bearer before forgetting it.
  const base = resolveIdentityBase();
  const bearer = bearerForIssuer(session, base, identityOrigin());
  const isolated =
    guestCookieObserved !== base &&
    (Boolean(session?.bearerOnly) || guestIsolationActive());
  if (isolated && bearer) rememberBearerRevoke(bearer, base);
  clearSession();
  setOrphan(false);
  const endedRevision = sessionRevision;
  // Complete revocation before reconnecting with the previous cookie.
  queueIdentityRevoke(async () => {
    try {
      if (!(await flushBearerRevokes(base))) {
        if (bearer) rememberBearerRevoke(bearer, base);
        setOrphan(true, base);
        return;
      }
      requireIssuer(base);
      if (!isolated) {
        const res = await revokeIdentityRequest(bearer, "include", base);
        requireIssuer(base);
        if (!res.ok) {
          if (bearer) rememberBearerRevoke(bearer, base);
          await recheckOrphan();
          return;
        }
        if (guestCookieObserved === base) guestCookieObserved = "";
      }
      if (sessionRevision === endedRevision && !session) clearGuestIsolation();
    } catch {
      // On network failure, assume the cookie may still authenticate.
      if (bearer) rememberBearerRevoke(bearer, base);
      if (resolveIdentityBase() !== base) setOrphan(true, base);
      else await recheckOrphan();
    }
  });
}

function queueRevoke(token: string, base = resolveIdentityBase()): void {
  rememberBearerRevoke(token, base);
  queueIdentityRevoke(async () => {
    if (!(await flushBearerRevokes(base)) && !session) setOrphan(true, base);
  });
}

async function recheckOrphan(): Promise<void> {
  if (session) return;
  const revision = sessionRevision;
  const found = await cookieAuthenticates(true, PROBE_MS);
  if (!session && sessionRevision === revision) setOrphan(found);
}

const identityOrigin = (): string => identityIssuerOrigin(identityBase);

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

/** Host requests use only the approved origin/key-bound DPoP grant. */
async function hostFetchDefault(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  await ensureHostSession();
  return fetchApprovedHost(hostBase(), path, init);
}

/** Fetch against the Identity API, attaching the session when we have one. */
async function identityFetchDefault(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const base = resolveIdentityBase();
  const headers = new Headers(init.headers);
  const active = currentSession();
  if (active && !active.cookieOnly) {
    headers.set("authorization", `Bearer ${active.accessToken}`);
  }
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await identityPlaneRequest(path, {
    ...init,
    headers,
    // Standalone guests and adopted bearers must not use an ambient cookie.
    credentials:
      active?.adopted ||
      active?.bearerOnly ||
      (!active && guestIsolationActive())
        ? "omit"
        : "include",
    timeoutMs: IDENTITY_FETCH_MS,
  });
  requireIssuer(base);
  if (res.status === 401 && active && session === active)
    identitySeams.noteUnauthorized();
  return res;
}

/** Drop a refused bearer and check whether its cookie survived. */
function noteUnauthorizedDefault(): void {
  if (!session) return;
  clearSession();
  void recheckOrphan();
}

async function identityJsonDefault<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return readIdentityJson<T>(await identityFetch(path, init));
}

/** Start a provisional session. This is the anonymous on-ramp the API exposes. */
async function connectProvisionalDefault(): Promise<IdentitySession> {
  if (guestIsolationActive()) {
    return currentSession() ?? connectFreshProvisionalDefault();
  }
  const resumed = await resumeCookieSession();
  if (resumed) return resumed;
  // Probe for an earlier tab's cookie before minting a second session.
  if (!session && !orphanSessionActive()) await probeOrphanSession();
  // Revoke any old session before starting another.
  if (session || orphanSessionActive()) endSession();
  // Finish earlier revokes before starting another session.
  await settleRevokes();
  return mintProvisionalSession(false, sessionRevision);
}

async function connectFreshProvisionalDefault(): Promise<IdentitySession> {
  await settleRevokes();
  const base = resolveIdentityBase();
  if (!(await retryBearerRevokes(base)))
    throw new IdentityError("Check your connection, then try again.", 503);
  const revision = sessionRevision;
  const inspected = await inspectRemoteIdentitySessionDefault(false);
  if (inspected.kind === "present" || currentSession()) {
    if (!currentSession()) {
      guestCookieObserved = base;
      setOrphan(true);
    }
    throw new IdentityError(
      "Sign out of the current account first, then continue as a fresh guest.",
      409,
    );
  }
  if (inspected.kind === "unknown" || sessionRevision !== revision) {
    throw new IdentityError("Check your connection, then try again.", 503);
  }
  return mintProvisionalSession(true, revision);
}

async function mintProvisionalSession(
  requireFreshGuest: boolean,
  expectedRevision: number,
): Promise<IdentitySession> {
  const epoch = sessionEpoch;
  const base = resolveIdentityBase();
  const issuerOrigin = identityOrigin();
  const body = await mintProvisionalCredential(requireFreshGuest, base);
  const accessToken = body.accessToken;
  requireIssuer(base, accessToken);
  if (sessionEpoch !== epoch) {
    // Do not adopt a credential after lock or sign-out.
    queueRevoke(accessToken, base);
    throw new IdentityError(
      "The session was ended while connecting. Connect again.",
      409,
    );
  }
  if (requireFreshGuest && sessionRevision !== expectedRevision) {
    queueRevoke(accessToken, base);
    throw new IdentityError(
      "Sign out of the current account first, then continue as a fresh guest.",
      409,
    );
  }
  if (requireFreshGuest) {
    const inspected = await inspectRemoteIdentitySessionDefault(false);
    requireIssuer(base, accessToken);
    if (inspected.kind !== "absent" || sessionRevision !== expectedRevision) {
      queueRevoke(accessToken, base);
      if (inspected.kind === "present" || currentSession()) {
        if (!currentSession()) {
          guestCookieObserved = base;
          setOrphan(true);
        }
        throw new IdentityError(
          "Sign out of the current account first, then continue as a fresh guest.",
          409,
        );
      }
      throw new IdentityError("Check your connection, then try again.", 503);
    }
    try {
      markGuestIsolation();
    } catch (error) {
      queueRevoke(accessToken, base);
      throw error;
    }
  }
  const nextSession: IdentitySession = {
    principalId: body.principalId,
    accessToken,
    expiresAt: body.expiresAt,
    issuerOrigin,
    issuerBase: base,
    ...(requireFreshGuest ? { bearerOnly: true } : undefined),
  };
  session = nextSession;
  if (guestCookieObserved === base) guestCookieObserved = "";
  setOrphan(false);
  emit();
  return nextSession;
}

async function resumeCookieSession(): Promise<IdentitySession | null> {
  if (guestIsolationActive() && !currentSession()) return null;
  const inspected = await inspectRemoteIdentitySessionDefault();
  return inspected.kind === "present" ? inspected.session : null;
}

type RemoteIdentitySessionInspection =
  | { kind: "present"; session: IdentitySession }
  | { kind: "absent" }
  | { kind: "unknown" };

function changedDuringInspection(
  revision: number,
): RemoteIdentitySessionInspection | null {
  if (sessionRevision === revision) return null;
  const active = currentSession();
  return active ? { kind: "present", session: active } : { kind: "unknown" };
}

async function inspectRemoteIdentitySessionDefault(
  adopt = true,
): Promise<RemoteIdentitySessionInspection> {
  const active = currentSession();
  if (active) return { kind: "present", session: active };
  // Device-native identity has no HttpOnly cookie plane.
  if (isDeviceIdentityMode()) return { kind: "absent" };
  const revision = sessionRevision;
  const base = resolveIdentityBase();
  const result = await probeIdentityCookie(PROBE_MS);
  if (resolveIdentityBase() !== base) return { kind: "unknown" };
  const changed = changedDuringInspection(revision);
  if (changed) return changed;
  if (result.kind !== "present") return result;
  const nextSession = cookieIdentitySession(
    result.principalId,
    identityOrigin(),
    base,
  );
  if (adopt) {
    session = nextSession;
    setOrphan(false);
    emit();
  }
  return { kind: "present", session: nextSession };
}

/** Revoke only the old bearer; a fresh guest's rebound bearer stays cookie-less. */
function standOnRebound(
  token: string,
  principalId: string,
  issuerOrigin: string,
  issuerBase: string,
): void {
  const previous =
    session &&
    !session.cookieOnly &&
    session.issuerOrigin === issuerOrigin &&
    (!session.issuerBase || session.issuerBase === issuerBase)
      ? session.accessToken
      : undefined;
  const guest = session?.bearerOnly || guestIsolationActive();
  session = {
    principalId,
    accessToken: token,
    adopted: true,
    issuerOrigin,
    issuerBase,
    ...(guest ? { bearerOnly: true } : undefined),
  };
  setOrphan(false);
  emit();
  if (previous && previous !== token) queueRevoke(previous, issuerBase);
}

/** Revoke a rebound token if sign-out or lock ended its session. */
function refuseEndedSession(
  serverBoundToken?: string,
  base = resolveIdentityBase(),
): never {
  if (serverBoundToken) {
    queueRevoke(serverBoundToken, base);
  }
  throw new IdentityError(
    "The session was ended while adopting that token. Try again.",
    409,
  );
}

async function adoptTokenDefault(
  accessToken: string,
  rebound = false,
  expectedEpoch?: number,
  expectedBase?: string,
): Promise<void> {
  const token = accessToken.trim();
  const base = expectedBase ?? resolveIdentityBase();
  requireIssuer(base, rebound ? token : undefined);
  if (session?.accessToken === token) return;
  // A rebind must retain the epoch in which its link request began.
  const epoch = expectedEpoch ?? sessionEpoch;
  if (sessionEpoch !== epoch)
    refuseEndedSession(rebound ? token : undefined, base);
  const issuerOrigin = identityOrigin();
  const principalId = await proveTokenOwner(token, IDENTITY_FETCH_MS);
  requireIssuer(base, rebound ? token : undefined);
  if (sessionEpoch !== epoch)
    refuseEndedSession(rebound ? token : undefined, base);
  if (rebound) {
    standOnRebound(token, principalId, issuerOrigin, base);
    return;
  }
  // Revoke any earlier cookie before adopting the pasted token.
  endSession();
  const adoptionEpoch = sessionEpoch;
  await settleRevokes();
  requireIssuer(base, token);
  if (sessionEpoch !== adoptionEpoch) {
    // Sign-out during revocation also fences this token.
    queueRevoke(token, base);
    throw new IdentityError(
      "The session was ended while adopting that token. Try again.",
      409,
    );
  }
  session = {
    principalId,
    accessToken: token,
    adopted: true,
    issuerOrigin,
    issuerBase: base,
    // The API supplies no expiry for a pasted token; a 401 ends it.
  };
  emit();
}

/** Put a stashed bearer back in this tab after an OIDC round-trip. */
function restoreSessionDefault(
  next: IdentitySession,
  expectedEpoch?: number,
  expectedBase?: string,
): void {
  const base = expectedBase ?? next.issuerBase ?? resolveIdentityBase();
  requireIssuer(base, next.cookieOnly ? undefined : next.accessToken);
  if (next.issuerOrigin !== identityOrigin()) {
    throw new IdentityError("The sign-in service changed. Try again.", 409);
  }
  if (expectedEpoch !== undefined && sessionEpoch !== expectedEpoch) {
    if (!next.cookieOnly) queueRevoke(next.accessToken, base);
    throw new IdentityError(
      "The session was ended while finishing sign-in. Sign in again.",
      409,
    );
  }
  if (session?.bearerOnly && session.accessToken !== next.accessToken)
    queueRevoke(session.accessToken, session.issuerBase);
  if (!next.bearerOnly) clearGuestIsolation();
  session = { ...next, issuerBase: base };
  if (guestCookieObserved === base) guestCookieObserved = "";
  setOrphan(false);
  emit();
}

export async function probeIdentityDetailed(): Promise<ProbeResult> {
  return probeIdentityPlane(identityBase, PROBE_MS);
}

export const identitySeams = {
  hostFetch: hostFetchDefault,
  endSession: endSessionDefault,
  ensureHostSession: async () => requireApprovedHostSession(hostBase()),
  hostLocalSessionEligible: (hostApi: string = hostBase()) =>
    hasApprovedHost(hostApi),
  currentSession: currentSessionDefault,
  probeOrphanSession: probeOrphanSessionDefault,
  identityBase: resolveIdentityBase,
  hostBase: hostApiBase,
  identityFetch: identityFetchDefault,
  noteUnauthorized: noteUnauthorizedDefault,
  identityJson: identityJsonDefault,
  connectProvisional: connectProvisionalDefault,
  connectFreshProvisional: connectFreshProvisionalDefault,
  resumeSession: resumeCookieSession,
  inspectRemoteSession: () => inspectRemoteIdentitySessionDefault(false),
  adoptToken: adoptTokenDefault,
  rebindSession: (
    accessToken: string,
    expectedEpoch?: number,
    expectedBase?: string,
  ) => adoptTokenDefault(accessToken, true, expectedEpoch, expectedBase),
  fetchPrincipal: () => identityJson<Principal>("/v1/principals/me"),
  restoreSession: restoreSessionDefault,
};

export async function hostFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return identitySeams.hostFetch(path, init);
}

export const endSession = (): void => identitySeams.endSession();

export const ensureHostSession = async (): Promise<HostSession> =>
  identitySeams.ensureHostSession();

export function hostLocalSessionEligible(hostApi?: string): boolean {
  // Let the seamed implementation resolve the default host.
  return hostApi === undefined
    ? identitySeams.hostLocalSessionEligible()
    : identitySeams.hostLocalSessionEligible(hostApi);
}

export const currentSession = (): IdentitySession | null =>
  identitySeams.currentSession();
export const probeOrphanSession = async (): Promise<boolean> =>
  identitySeams.probeOrphanSession();
export const identityBase = (): string => identitySeams.identityBase();
export const hostBase = (): string => identitySeams.hostBase();
export const noteUnauthorized = (): void => identitySeams.noteUnauthorized();
export async function identityFetch(
  ...args: Parameters<typeof identityFetchDefault>
): ReturnType<typeof identityFetchDefault> {
  return identitySeams.identityFetch(...args);
}
export async function identityJson<T>(
  ...args: Parameters<typeof identityJsonDefault>
): Promise<T> {
  return identitySeams.identityJson<T>(...args);
}
export const connectProvisional = async (): Promise<IdentitySession> =>
  identitySeams.connectProvisional();
export async function adoptToken(accessToken: string): Promise<void> {
  return identitySeams.adoptToken(accessToken);
}
/** Stand on a session the link route rebound to an existing principal. */
export async function rebindSession(
  accessToken: string,
  expectedEpoch?: number,
  expectedBase?: string,
): Promise<void> {
  return identitySeams.rebindSession(accessToken, expectedEpoch, expectedBase);
}
export const probeIdentity = async (): Promise<HealthState> =>
  (await probeIdentityDetailed()).health;
export const connectFreshProvisional = async (): Promise<IdentitySession> =>
  identitySeams.connectFreshProvisional();

export const fetchPrincipal = async (): Promise<Principal> =>
  identitySeams.fetchPrincipal();

export function restoreSession(
  next: IdentitySession,
  expectedEpoch?: number,
  expectedBase?: string,
): void {
  identitySeams.restoreSession(next, expectedEpoch, expectedBase);
}

/** Fence value for work that must not restore across a sign-out. */
export function identitySessionEpoch(): number {
  return sessionEpoch;
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
