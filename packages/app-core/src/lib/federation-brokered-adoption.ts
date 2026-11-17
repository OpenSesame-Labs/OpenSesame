import {
  type BoundaryValue,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { lockManager } from "../ports.js";
import { FederationError } from "./federation-error.js";
import {
  type FederationSessionGeneration,
  federationSessionGeneration,
} from "./federation-native-session.js";
import {
  type IdentitySession,
  identitySessionEpoch,
  remoteIdentityApi,
  restoreSession,
} from "./identity.js";
import {
  identityOriginFor,
  revokeRequest,
} from "./identity-cookie-transport.js";
import { queueIssuerRevocation } from "./identity-revocation-queue.js";
import { localNetworkFetch } from "./local-network-fetch.js";

/**
 * Trade the brokered access token for a first-party session (C13/D8).
 *
 * The Identity API looks the token up in its own store, reads the principal it
 * was issued for, and mints a provisional bearer for that same principal. No
 * identity row is written and no principal is minted — which is exactly why
 * this, and not `link-identities`, is the brokered adoption path (T23).
 */
export async function adoptBrokeredSessionDefault(
  accessToken: string,
  expectedGeneration?: FederationSessionGeneration,
  assertOriginal: () => void = () => undefined,
): Promise<IdentitySession> {
  const locks = lockManager();
  const run = () =>
    adoptBrokeredSessionLocked(accessToken, expectedGeneration, assertOriginal);
  return locks
    ? locks.request(
        "opensesame:identity-cookie-session",
        { mode: "shared" },
        run,
      )
    : run();
}

async function adoptBrokeredSessionLocked(
  accessToken: string,
  expectedGeneration?: FederationSessionGeneration,
  assertOriginal: () => void = () => undefined,
): Promise<IdentitySession> {
  assertOriginal();
  const generation = expectedGeneration ?? federationSessionGeneration();
  const sessionEpoch = identitySessionEpoch();
  if (federationSessionGeneration() !== generation)
    throw new FederationError(
      "sign_in_cancelled",
      "That sign-in was ended by a sign-out. Start again.",
    );
  const base = remoteIdentityApi();
  if (!base) {
    throw new FederationError(
      "no_identity_api",
      "No sign-in service is connected, so this sign-in cannot be adopted.",
    );
  }
  let response: Response;
  try {
    response = await localNetworkFetch(
      `${base}/v1/principals/federated-session`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The token IS the credential here; a cookie beside it would let a
        // surviving session answer in its place.
        credentials: "omit",
        body: JSON.stringify({ accessToken }),
      },
    );
  } catch {
    throw new FederationError(
      "identity_unavailable",
      `Could not reach the sign-in service at ${base} to finish signing in.`,
    );
  }
  assertOriginal();
  if (!response.ok) {
    throw new FederationError(
      "session_adoption_failed",
      response.status === 401
        ? "That sign-in expired before it could be adopted. Try again."
        : `The sign-in service refused the sign-in (${response.status}).`,
    );
  }
  const body: {
    principalId?: BoundaryValue;
    accessToken?: BoundaryValue;
    expiresAt?: BoundaryValue;
  } = overlapCast(await response.json());
  assertOriginal();
  if (!isString(body.principalId) || !isString(body.accessToken)) {
    throw new FederationError(
      "session_adoption_failed",
      "The sign-in service returned an unusable session.",
    );
  }
  const session: IdentitySession = {
    principalId: body.principalId,
    accessToken: body.accessToken,
    issuerOrigin: identityOriginFor(() => base),
    ...(isString(body.expiresAt) ? { expiresAt: body.expiresAt } : undefined),
  };
  // The generation was checked before the request; check it again before the
  // synchronous adoption so a sign-out during the exchange cannot be undone.
  if (federationSessionGeneration() !== generation)
    throw new FederationError(
      "sign_in_cancelled",
      "That sign-in was ended by a sign-out. Start again.",
    );
  try {
    assertOriginal();
    restoreSession(session, sessionEpoch);
  } catch (error) {
    const issuer = identityOriginFor(() => base);
    queueIssuerRevocation(
      issuer,
      () => identityOriginFor(remoteIdentityApi),
      () => revokeRequest(body.accessToken as string, "omit"),
    );
    throw error;
  }
  return session;
}
