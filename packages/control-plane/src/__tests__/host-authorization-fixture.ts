import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { expect } from "vitest";
import {
  type CreateControlPlaneOptions,
  createControlPlane,
} from "../create-app.js";

/** One Identity plane with a registered passkey and a Host challenge. */
export async function fixture(options: CreateControlPlaneOptions = {}) {
  const signingKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).privateKey.export({ format: "jwk" });
  const planeOptions = {
    ...options,
    config: { ...options.config, publicUrl: "http://localhost:8788" },
    processEnv: {
      ...process.env,
      // Replicas sharing this database must retain the same sealing root.
      OPENSESAME_EVENT_KEY: "host-authorization-shared-database-sealing-root",
      OPENSESAME_CLAIM_PEPPER:
        "host-authorization-shared-database-claim-pepper",
      OPENSESAME_HOST_AUTHORIZATION_AUDIENCES: "http://127.0.0.1:8787",
      OPENSESAME_JWKS_JSON: JSON.stringify({
        keys: [
          { ...signingKey, alg: "RS256", kid: "test-host-key", use: "sig" },
        ],
      }),
    },
  };
  const plane = createControlPlane(planeOptions);
  const minted = await (
    await plane.app.request("/v1/principals/provisional", { method: "POST" })
  ).json();
  const memberships =
    await plane.ctx.stores.organizationMemberships.listByPrincipal(
      minted.principalId,
    );
  const organizationId = memberships[0]?.organizationId;
  if (!organizationId) throw new Error("Fixture organization missing");
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = key.publicKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.y) throw new Error("Fixture public coordinates missing");
  const publicKey = Buffer.concat([
    Buffer.from("a5010203262001215820", "hex"),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from("225820", "hex"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  const credentialId = randomBytes(32).toString("base64url");
  await plane.ctx.passkeys.register(minted.principalId, {
    credentialId,
    publicKey,
    counter: 0,
  });
  const headers = {
    authorization: `Bearer ${minted.accessToken}`,
    "content-type": "application/json",
  };
  const challenge = {
    challenge_id: "challenge_1",
    challenge_digest: "a".repeat(64),
    host_audience: "http://127.0.0.1:8787",
    organization_id: organizationId,
    operation: "agent.browser.control",
    transition: "take",
    target_id: "run_1",
    origin: "https://vault.example",
    dpop_jkt: "b".repeat(43),
    expires_at: Math.floor(Date.now() / 1000) + 240,
  };
  async function begin() {
    const response = await plane.app.request(
      "/v1/host-authorizations/options",
      { method: "POST", headers, body: JSON.stringify(challenge) },
    );
    expect(response.status).toBe(200);
    return response.json();
  }
  function assertion(
    pending: { authorization_id: string; options: { challenge: string } },
    uv = true,
    counter = 1,
  ) {
    const clientData = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: pending.options.challenge,
        origin: "http://localhost:8788",
      }),
    );
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    const authData = Buffer.concat([
      createHash("sha256").update("localhost").digest(),
      Buffer.from([uv ? 5 : 1]),
      count,
    ]);
    const signature = sign(
      "sha256",
      Buffer.concat([
        authData,
        createHash("sha256").update(clientData).digest(),
      ]),
      key.privateKey,
    );
    return {
      authorization_id: pending.authorization_id,
      credentialId,
      clientDataJSON: clientData.toString("base64url"),
      authenticatorData: authData.toString("base64url"),
      signature: signature.toString("base64url"),
    };
  }
  const verify = (body: ReturnType<typeof assertion>) =>
    plane.app.request("/v1/host-authorizations/verify", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  return {
    ...plane,
    planeOptions,
    minted,
    headers,
    challenge,
    begin,
    assertion,
    verify,
  };
}
