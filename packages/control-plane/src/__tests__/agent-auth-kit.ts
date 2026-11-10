import { PROVIDER_ID_JAG_TYP } from "@opensesame/agent-protocols";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { expect } from "vitest";
import { createControlPlane } from "../create-app.js";

/** Shared fixtures for the AgentAuth suites. */

export async function app() {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
  }).app;
}

export async function json(res: Response) {
  return overlapCast(await res.json());
}

export async function verifiedWithEmail(
  hono: ReturnType<typeof createControlPlane>["app"],
  email: string,
) {
  const created = await hono.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(created.status).toBe(201);
  const body = await json(created);
  const auth = { authorization: `Bearer ${body.accessToken}` };
  const linked = await hono.request("/v1/principals/link-identities", {
    method: "POST",
    headers: {
      ...auth,
      "content-type": "application/json",
      "idempotency-key": `verify-${email}`,
    },
    body: JSON.stringify({
      kind: "oidc",
      issuer: "https://mock.example",
      subject: `sub-${email}`,
      emailNormalized: email,
      emailVerified: true,
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  return { auth, principalId: String(body.principalId) };
}

export async function providerApp() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "idp-1";
  jwk.alg = "ES256";
  const cp = createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
    processEnv: {
      OPENSESAME_ALLOW_DEV_DEFAULTS: "1",
      OPENSESAME_AGENT_AUTH_PROVIDER_ASSERTION_ENABLED: "true",
      OPENSESAME_AGENT_AUTH_TRUSTED_PROVIDERS_JSON: JSON.stringify([
        {
          issuer: "https://idp.example",
          enabled: true,
          audiences: ["http://127.0.0.1:8788"],
          algorithms: ["ES256"],
          maxAgeSeconds: 600,
          jwks: { keys: [jwk] },
        },
      ]),
    },
  });
  return { hono: cp.app, ctx: cp.ctx, privateKey };
}

export type IdJagOverrides = {
  iss?: string;
  aud?: string;
  jti?: string;
  sub?: string;
  email?: string;
  emailVerified?: boolean;
  authTimeOffset?: number;
  omitAuthTime?: boolean;
};

export async function idJag(
  privateKey: CryptoKey,
  overrides: IdJagOverrides = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const claims: JsonObject = {
    sub: overrides.sub ?? "user_idp_1",
    email: overrides.email ?? "idp-user@example.com",
    email_verified: overrides.emailVerified ?? true,
  };
  if (!overrides.omitAuthTime) {
    claims.auth_time = now + (overrides.authTimeOffset ?? 0);
  }
  return new SignJWT(claims)
    .setProtectedHeader({
      alg: "ES256",
      typ: PROVIDER_ID_JAG_TYP,
      kid: "idp-1",
    })
    .setIssuer(overrides.iss ?? "https://idp.example")
    .setAudience(overrides.aud ?? "http://127.0.0.1:8788")
    .setJti(
      overrides.jti ?? `jti-${now}-${Math.random().toString(16).slice(2)}`,
    )
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}
