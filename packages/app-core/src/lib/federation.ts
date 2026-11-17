import type { JsonObject } from "@opensesame/os-domain";
import { decodeJwtEnvelope, sha256Base64Url } from "@opensesame/sdk-browser";
import { page } from "../ports.js";
import { ambientAuthSeams } from "./ambient-auth-seam.js";
import {
  type CallbackCapture,
  captureFederationAction,
} from "./federation-action-owner.js";
import { isBrokeredIssuer } from "./federation-broker.js";
import { adoptBrokeredSessionDefault } from "./federation-brokered-adoption.js";
import { parseAuthCallback } from "./federation-callback.js";

export { isBrokeredIssuer } from "./federation-broker.js";

import type {
  BeginSignInOptions,
  CompletedSignIn,
  OidcDiscovery,
  TrustedUpstream,
} from "./federation-contract.js";
import {
  federationCurrentSessionSeam,
  issuerIsTrusted,
  loadCurrentFederationSession,
} from "./federation-current-session.js";

export type {
  BeginSignInOptions,
  CompletedSignIn,
  OidcDiscovery,
  TrustedUpstream,
} from "./federation-contract.js";

import {
  consumeBrokeredPublication,
  runOwnedFederationExchange,
} from "./federation-publication.js";

export {
  federationExchangeSeams,
  saveSession,
} from "./federation-publication.js";

import { FederationError } from "./federation-error.js";
import {
  type FederationSessionGeneration,
  type UpstreamIdentity,
  upstreamIdentityDisplayName as displayNameDefault,
} from "./federation-native-session.js";
import { isOperatorIdpIssuer } from "./federation-operator.js";
import { originCallbackUri } from "./federation-origin.js";
import { takeMatchingPending } from "./federation-pending.js";
import { bindPendingOwner } from "./federation-pending-owner.js";
import { clearFederationSession as clearSessionDefault } from "./federation-retirement.js";
import {
  TRUSTED_UPSTREAMS,
  defaultUpstreamDefault,
} from "./federation-upstreams.js";

export { TRUSTED_UPSTREAMS, upstreamByIssuer } from "./federation-upstreams.js";

import type { IdentitySession } from "./identity.js";

export { FederationError } from "./federation-error.js";
export {
  isOperatorIdpIssuer,
  operatorUpstream,
} from "./federation-operator.js";
export {
  originCallbackUri,
  originClientId,
  redirectUri,
} from "./federation-origin.js";

/**
 * Federated sign-in against a trusted upstream broker (ADR 0033).
 *
 * This app is a static deployment: it has no server, so it holds no client
 * secret and mints nothing. It is a public OAuth client whose `client_id` is
 * derived from its own origin, and the identity it ends up with was signed by
 * the upstream, not here. The wire contract is
 * docs/architecture/federated-signin.md §1.
 */

export type { UpstreamIdentity } from "./federation-native-session.js";

export function decodeJwtClaims(token: string): JsonObject {
  const payload = token.split(".")[1];
  if (!payload) throw new FederationError("invalid_token", "Not a JWT.");
  try {
    return decodeJwtEnvelope(token).claims;
  } catch {
    throw new FederationError("invalid_token", "Token payload is not JSON.");
  }
}

/**
 * The subject a relying party at `origin` derives for itself, per
 * docs/architecture/federated-signin.md §3. Computed the same way here only so
 * the consent screen can show what an origin will learn.
 */
export async function derivedSubjectFor(
  pairwiseSub: string,
  origin: string,
): Promise<string> {
  return sha256Base64Url(`${pairwiseSub}:${origin}`);
}

export const federationStartSeams = {
  load: (): Promise<typeof import("./federation-start.js")> =>
    import("./federation-start.js"),
};

export async function discover(issuer: string): Promise<OidcDiscovery> {
  const captured = captureFederationAction();
  const { discoverCaptured } = await federationStartSeams.load();
  captured.assertCurrent();
  return discoverCaptured(issuer, captured);
}

async function beginSignInDefault(
  upstream: TrustedUpstream,
  options: BeginSignInOptions = {},
): Promise<void> {
  const captured = captureFederationAction();
  const originalUpstream = Object.freeze({ ...upstream });
  const context = Object.freeze({
    upstream: originalUpstream,
    options: Object.freeze({ ...options }),
    owner: captured,
    redirectUri: isBrokeredIssuer(originalUpstream.issuer)
      ? originCallbackUri()
      : captured.redirectUri,
    clientId: originalUpstream.clientId ?? captured.clientId,
    navigate(url: string) {
      captured.assertCurrent();
      page().location.assign(url);
    },
  });
  const { beginCapturedSignIn } = await federationStartSeams.load();
  captured.assertCurrent();
  return beginCapturedSignIn(context);
}

export { hasAuthResponse } from "./federation-response.js";

/** Capture the initiating tab and session before any sign-in prerequisite awaits. */
export function captureSignInCheck(): () => void {
  return captureFederationAction().assertCurrent;
}

/**
 * Finish a redirect that `beginSignIn` started. Returns null when this load is
 * not an upstream response, so it is safe to call on every startup.
 */
async function completeSignInDefault(
  captured: CallbackCapture,
): Promise<CompletedSignIn | null> {
  const parsed = parseAuthCallback(captured.search);
  if (parsed.kind === "none") return null;
  captured.assertCurrent();
  if (parsed.kind === "malformed") {
    captured.scrub();
    throw new FederationError(
      parsed.reason,
      "This sign-in response was not usable.",
    );
  }
  const state = parsed.state;
  const { pending, stale, unmatched } = takeMatchingPending(state);
  captured.scrub();

  if (unmatched) {
    throw new FederationError(
      "invalid_request",
      "Sign-in state did not match.",
    );
  }
  if (parsed.kind === "error") {
    throw new FederationError(
      parsed.error,
      parsed.description ?? `The broker refused: ${parsed.error}.`,
    );
  }
  const code = parsed.code;
  if (!pending) {
    // A code with NO pending record at all is usually a replay — the callback
    // URL reopened from history or a bookmark after the sign-in already
    // finished. When a live session exists, this load is not a failed sign-in
    // and must not be turned into one: the code is already spent (or somebody
    // else's), the person is signed in, and the app just proceeds. A STALE
    // record is different: a real ceremony was in flight and went bad, so it
    // is refused out loud even beside a live session — silence here would
    // discard an account-switch sign-in without a word.
    if (!stale && loadCurrentFederationSession()) return null;
    throw new FederationError(
      "invalid_request",
      "This sign-in expired or started somewhere else. Start again from the sign-in screen.",
    );
  }
  // Binds the response to the request this tab made; without it a link could
  // drop someone else's code here.
  if (!state || state !== pending.state) {
    throw new FederationError(
      "invalid_request",
      "Sign-in state did not match.",
    );
  }
  if (!code) {
    throw new FederationError(
      "invalid_request",
      "The broker returned no code.",
    );
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    // Byte-identical to what the authorize request carried, whichever shape
    // that was — token endpoints compare, not resolve.
    redirect_uri: pending.redirectUri ?? captured.redirectUri,
    client_id: pending.clientId ?? captured.clientId,
    code_verifier: pending.verifier,
  });

  const owner = bindPendingOwner(captured, pending);
  const context = Object.freeze({
    pending: Object.freeze({ ...pending }),
    body: body.toString(),
    origin: captured.origin,
    clientId: pending.clientId ?? captured.clientId,
    upstreams: Object.freeze(
      TRUSTED_UPSTREAMS.map((upstream) => Object.freeze({ ...upstream })),
    ),
    assertCurrent: owner.assertCurrent,
    decodeClaims: decodeJwtClaims,
    issuerTrusted: issuerIsTrusted,
    issuerBrokered: isBrokeredIssuer,
    subjectIsPairwise: (issuer: string) =>
      isBrokeredIssuer(issuer) || isOperatorIdpIssuer(issuer),
  });
  return runOwnedFederationExchange(context, owner);
}

/** Strip the code out of the address bar so a reload cannot replay it. */
export function clearAuthResponseFromUrl(): void {
  const url = new URL(page().location.href);
  for (const key of ["code", "state", "error", "error_description", "scope"]) {
    url.searchParams.delete(key);
  }
  page().replaceUrl(url.toString());
}

async function completeSignInWired(): Promise<CompletedSignIn | null> {
  const captured = captureFederationAction();
  const ambient = await ambientAuthSeams.completeIfPresent(captured.search);
  if (ambient) {
    clearAuthResponseFromUrl();
    return ambient;
  }
  return completeSignInDefault(captured);
}

export const federationSeams = {
  defaultUpstream: defaultUpstreamDefault,
  beginSignIn: beginSignInDefault,
  completeSignIn: completeSignInWired,
  adoptBrokeredSession: adoptBrokeredSessionDefault,
  get loadSession() {
    return federationCurrentSessionSeam.load;
  },
  set loadSession(load: typeof federationCurrentSessionSeam.load) {
    federationCurrentSessionSeam.load = load;
  },
  clearSession: clearSessionDefault,
  displayName: displayNameDefault,
};

export function defaultUpstream(): TrustedUpstream {
  return federationSeams.defaultUpstream();
}

export async function beginSignIn(
  upstream: TrustedUpstream,
  options: BeginSignInOptions = {},
): Promise<void> {
  const check = captureSignInCheck();
  const { prepareFederatedSignIn } = await import("./guest-signin-gate.js");
  await prepareFederatedSignIn(check);
  return federationSeams.beginSignIn(upstream, options);
}

export async function completeSignIn(): Promise<CompletedSignIn | null> {
  return federationSeams.completeSignIn();
}

export async function adoptBrokeredSession(
  accessToken: string,
  expectedGeneration?: FederationSessionGeneration,
): Promise<IdentitySession> {
  const owner = consumeBrokeredPublication(accessToken, expectedGeneration);
  return owner
    ? federationSeams.adoptBrokeredSession(
        accessToken,
        owner.generation,
        owner.assertCurrent,
      )
    : federationSeams.adoptBrokeredSession(accessToken, expectedGeneration);
}

export function loadSession(): UpstreamIdentity | null {
  return federationSeams.loadSession();
}

export function clearSession(): void {
  federationSeams.clearSession();
}

export function displayName(identity: UpstreamIdentity): string {
  return federationSeams.displayName(identity);
}
