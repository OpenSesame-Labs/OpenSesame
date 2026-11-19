/** Canonical saved-generation publication and one-use handoff from the actual verified exchange. */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { CompletedSignIn } from "./federation-contract.js";
import { FederationError } from "./federation-error.js";
import type { FederationExchangeContext } from "./federation-exchange.js";
import {
  type FederationSessionGeneration,
  type UpstreamIdentity,
  advanceFederationSessionGeneration,
  federationSessionGeneration,
  isNativeFederationFormat,
} from "./federation-native-session.js";
import {
  clearFederationSessionJson,
  writeFederationSessionJson,
} from "./federation-session-store.js";
import {
  type IdentitySession,
  identitySessionEpoch,
  remoteIdentityApi,
  restoreSession,
} from "./identity.js";
import {
  flushBearerRevokes,
  queueIdentityRevoke,
  rememberBearerRevoke,
} from "./identity-token-proof.js";
import { rememberLastSignIn } from "./last-sign-in.js";
import { localNetworkFetch } from "./local-network-fetch.js";
import { onVaultLock } from "./vault/lock-events.js";

type CompletionOwner = Readonly<{
  generation: FederationSessionGeneration;
  assertCurrent: () => void;
  assertConfiguration: () => void;
}>;
type BrokeredPublication = Readonly<{
  accessToken: string;
  initiating: FederationSessionGeneration;
  published: FederationSessionGeneration;
  assertConfiguration: () => void;
}>;
type SavedPublication = Readonly<{
  generation: FederationSessionGeneration;
  identity: UpstreamIdentity;
}>;
type PublicationSlot = { current: SavedPublication | null };
type ExchangeRequest = Pick<
  FederationExchangeContext,
  | "pending"
  | "body"
  | "origin"
  | "clientId"
  | "upstreams"
  | "assertCurrent"
  | "decodeClaims"
  | "issuerTrusted"
  | "issuerBrokered"
  | "subjectIsPairwise"
>;
let brokeredPublication: BrokeredPublication | null = null;
export function forgetBrokeredPublication(): void {
  brokeredPublication = null;
}
export const federationExchangeSeams = {
  load: (): Promise<typeof import("./federation-exchange.js")> =>
    import("./federation-exchange.js"),
};

function assertGeneration(expected: FederationSessionGeneration): void {
  if (federationSessionGeneration() !== expected)
    throw new FederationError(
      "sign_in_cancelled",
      "That sign-in was ended by a sign-out. Start again.",
    );
}

// The generation also fences an adoption whose one-use receipt was already consumed.
onVaultLock(() => {
  brokeredPublication = null;
  advanceFederationSessionGeneration();
});

/** Saved JWT metadata retains the original API; native protocol evidence cannot be serialized here. */
export function saveSession(
  identity: UpstreamIdentity,
  expectedGeneration?: FederationSessionGeneration,
): FederationSessionGeneration {
  if (isNativeFederationFormat(identity.assertionFormat))
    throw new Error(
      "Native identity evidence must remain in its verified browser session",
    );
  if (expectedGeneration !== undefined) assertGeneration(expectedGeneration);
  const published = advanceFederationSessionGeneration();
  brokeredPublication = null;
  assertGeneration(published);
  writeFederationSessionJson(JSON.stringify(identity));
  assertGeneration(published);
  rememberLastSignIn(identity.upstreamId);
  assertGeneration(published);
  return published;
}

/** This helper invokes the real deferred verifier; a serialized result cannot manufacture a receipt. */
export async function runOwnedFederationExchange(
  request: ExchangeRequest,
  owner: CompletionOwner,
): Promise<CompletedSignIn> {
  const publication: PublicationSlot = { current: null };
  const { exchangeCapturedSignIn } = await federationExchangeSeams.load();
  owner.assertCurrent();
  const context = Object.freeze({
    ...request,
    save(identity: UpstreamIdentity) {
      publication.current = Object.freeze({
        generation: saveSession(identity, owner.generation),
        identity,
      });
    },
  });
  try {
    const result = await exchangeCapturedSignIn(context);
    // Org returns deliberately do not save a durable federation session.
    const published = publication.current;
    if (!published) {
      owner.assertCurrent();
      return result;
    }
    assertGeneration(published.generation);
    owner.assertConfiguration();
    if (result.identity !== published.identity)
      throw new FederationError(
        "invalid_request",
        "The completed identity changed during publication",
      );
    if (result.accessToken)
      brokeredPublication = Object.freeze({
        accessToken: result.accessToken,
        initiating: owner.generation,
        published: published.generation,
        assertConfiguration: owner.assertConfiguration,
      });
    return result;
  } catch (error) {
    // Never erase a newer authentication when retiring this exact failed publication.
    const published = publication.current;
    if (published && federationSessionGeneration() === published.generation) {
      advanceFederationSessionGeneration();
      clearFederationSessionJson();
    }
    throw error;
  }
}

/** Only the exact token and initiating owner from a real completion may cross its own save transition. */
export function consumeBrokeredPublication(
  accessToken: string,
  initiating: FederationSessionGeneration | undefined,
): Readonly<{
  generation: FederationSessionGeneration;
  assertCurrent: () => void;
}> | null {
  const original = brokeredPublication;
  if (
    !original ||
    original.accessToken !== accessToken ||
    original.initiating !== initiating
  )
    return null;
  brokeredPublication = null;
  const assertCurrent = () => {
    assertGeneration(original.published);
    original.assertConfiguration();
  };
  assertCurrent();
  return Object.freeze({ generation: original.published, assertCurrent });
}

async function readAdoptionResponse(
  response: Response,
): Promise<BoundaryValue> {
  try {
    return overlapCast(await response.json());
  } catch (error) {
    if (response.ok) throw error;
    return undefined;
  }
}

/** Adopt a brokered token only for its original owner, retiring any unusable response. */
export async function adoptBrokeredSessionDefault(
  accessToken: string,
  expectedGeneration?: FederationSessionGeneration,
  assertOriginal: () => void = () => undefined,
): Promise<IdentitySession> {
  assertOriginal();
  const generation = expectedGeneration ?? federationSessionGeneration();
  const sessionEpoch = identitySessionEpoch();
  assertGeneration(generation);
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
        // Never allow an ambient cookie to answer in place of this token.
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
  const body = await readAdoptionResponse(response);
  const issued =
    isJsonObject(body) && isString(body.accessToken)
      ? body.accessToken
      : undefined;
  try {
    assertOriginal();
    if (!response.ok) {
      throw new FederationError(
        "session_adoption_failed",
        response.status === 401
          ? "That sign-in expired before it could be adopted. Try again."
          : `The sign-in service refused the sign-in (${response.status}).`,
      );
    }
    if (!isJsonObject(body) || !isString(body.principalId) || !issued) {
      throw new FederationError(
        "session_adoption_failed",
        "The sign-in service returned an unusable session.",
      );
    }
    assertGeneration(generation);
    const session: IdentitySession = {
      principalId: body.principalId,
      accessToken: issued,
      issuerOrigin: new URL(base).origin,
      issuerBase: base,
      ...(isString(body.expiresAt) ? { expiresAt: body.expiresAt } : undefined),
    };
    restoreSession(session, sessionEpoch, base);
    return session;
  } catch (error) {
    if (issued) {
      rememberBearerRevoke(issued, base);
      queueIdentityRevoke(async () => {
        await flushBearerRevokes(base);
      });
    }
    throw error;
  }
}
