import { createHash, randomBytes } from "node:crypto";
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import type { ReferenceIdp } from "./testkit.js";

export interface ReferenceOidcGrant {
  issuer: string;
  clientId: string;
  nonce: string;
  idToken: string;
}

function localIssuer(raw: string): URL {
  const issuer = new URL(raw);
  if (
    issuer.protocol !== "http:" ||
    issuer.hostname !== "127.0.0.1" ||
    issuer.origin !== raw
  ) {
    throw new Error("reference IdP issuer must be a loopback origin");
  }
  return issuer;
}

function assertRelyingPartyOrigin(origin: string): void {
  const relyingParty = new URL(origin);
  if (
    relyingParty.origin !== origin ||
    (relyingParty.protocol !== "https:" && relyingParty.protocol !== "http:")
  ) {
    throw new Error("reference relying party must be a canonical HTTP origin");
  }
}

/**
 * Complete an origin-profile authorization-code grant against a local
 * reference IdP. The returned ID token is signed by that IdP; callers still
 * have to verify it with their own SDK. This driver does not follow the RP
 * redirect or contact any host other than the local IdP.
 */
export async function obtainReferenceOidcGrant(
  idp: Pick<ReferenceIdp, "issuer">,
  origin = "http://127.0.0.1:4711",
): Promise<ReferenceOidcGrant> {
  const issuer = localIssuer(idp.issuer);
  assertRelyingPartyOrigin(origin);

  const clientId = `origin:${origin}`;
  const redirectUri = `${origin}/opensesame/callback`;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const nonce = randomBytes(24).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const deadline = AbortSignal.timeout(10_000);
  const authorization = new URL("/authorize", issuer);
  authorization.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
  }).toString();
  const response = await fetch(authorization, {
    redirect: "manual",
    signal: deadline,
  });
  const location = response.headers.get("location");
  if (response.status !== 302 || !location)
    throw new Error(`reference authorization failed: ${response.status}`);
  const callback = new URL(location);
  if (
    callback.origin !== origin ||
    callback.pathname !== "/opensesame/callback" ||
    callback.searchParams.get("state") !== state
  ) {
    throw new Error("reference authorization callback mismatch");
  }
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("reference authorization returned no code");

  const tokenResponse = await fetch(new URL("/token", issuer), {
    method: "POST",
    redirect: "error",
    signal: deadline,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    }),
  });
  if (!tokenResponse.ok) {
    await tokenResponse.body?.cancel();
    throw new Error(`reference token exchange failed: ${tokenResponse.status}`);
  }
  if (tokenResponse.headers.get("access-control-allow-origin") !== origin) {
    await tokenResponse.body?.cancel();
    throw new Error("reference token exchange did not allow the RP origin");
  }
  const tokens: BoundaryValue = await tokenResponse.json();
  if (!isJsonObject(tokens) || !isString(tokens.id_token) || !tokens.id_token) {
    throw new Error("reference token exchange returned no ID token");
  }
  return { issuer: idp.issuer, clientId, nonce, idToken: tokens.id_token };
}
