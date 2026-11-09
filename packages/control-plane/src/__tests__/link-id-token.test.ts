import { overlapCast } from "@opensesame/os-domain";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import {
  orgAssertionSeams,
  resetOrgAssertionCaches,
} from "../routes/org-assertion.js";

const ISSUER = "http://127.0.0.1:9090";

async function mintKeys() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "claim-1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwks: { keys: [jwk] } };
}

async function guest(app: ReturnType<typeof createControlPlane>["app"]) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

describe("claiming a guest principal with an upstream id_token", () => {
  const originalDiscover = orgAssertionSeams.discoverJwksUri;

  afterEach(() => {
    orgAssertionSeams.discoverJwksUri = originalDiscover;
    resetOrgAssertionCaches();
    vi.unstubAllGlobals();
  });

  it("promotes the same principal when the id_token verifies", async () => {
    const { privateKey, jwks } = await mintKeys();
    orgAssertionSeams.discoverJwksUri = async () => `${ISSUER}/jwks`;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(jwks))),
    );

    const { app } = createControlPlane();
    const created = await guest(app);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "claim-1" })
      .setIssuer(ISSUER)
      .setAudience("origin:http://127.0.0.1:8788")
      .setSubject("alice@upstream")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const linked = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ idToken: token }),
    });
    expect(linked.status).toBe(201);
    expect(overlapCast(await linked.json())).toMatchObject({
      principalId: created.principalId,
      identity: {
        issuer: ISSUER,
        subject: "alice@upstream",
        assurance: "verified",
      },
    });

    const me = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${created.accessToken}` },
    });
    expect(overlapCast(await me.json())).toMatchObject({
      id: created.principalId,
      assurance: "verified",
    });
  });

  it("rebinds a throwaway provisional to the existing principal on return sign-in", async () => {
    const { privateKey, jwks } = await mintKeys();
    orgAssertionSeams.discoverJwksUri = async () => `${ISSUER}/jwks`;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(jwks))),
    );
    const { app } = createControlPlane();
    const first = await guest(app);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "claim-1" })
      .setIssuer(ISSUER)
      .setAudience("origin:http://127.0.0.1:8788")
      .setSubject("returning@upstream")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const linked = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        authorization: `Bearer ${first.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ idToken: token }),
    });
    expect(linked.status).toBe(201);

    // The same person returns with no surviving session: a fresh throwaway
    // provisional is minted for the trip, but the verified identity must
    // land back on the original principal and rebind the session there.
    const second = await guest(app);
    expect(second.principalId).not.toBe(first.principalId);
    const rebound = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        authorization: `Bearer ${second.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ idToken: token }),
    });
    expect(rebound.status).toBe(200);
    const body = overlapCast(await rebound.json());
    expect(body.principalId).toBe(first.principalId);
    expect(body.accessToken).toBeTruthy();
    const me = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(overlapCast(await me.json()).id).toBe(first.principalId);
  });

  it("keeps the rebound session alive when the old Bearer is revoked without its cookie", async () => {
    // The client's rebind ends the throwaway session by Bearer alone,
    // withholding cookies: the revoke route ends every credential a
    // request presents, and the cookie already names the rebound session.
    const { privateKey, jwks } = await mintKeys();
    orgAssertionSeams.discoverJwksUri = async () => `${ISSUER}/jwks`;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(jwks))),
    );
    const { app } = createControlPlane();
    const first = await guest(app);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "claim-1" })
      .setIssuer(ISSUER)
      .setAudience("origin:http://127.0.0.1:8788")
      .setSubject("surviving@upstream")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const link = (bearer: string) =>
      app.request("/v1/principals/link-identities", {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ idToken: token }),
      });
    expect((await link(first.accessToken)).status).toBe(201);
    const second = await guest(app);
    const rebound = await link(second.accessToken);
    expect(rebound.status).toBe(200);
    const body = overlapCast(await rebound.json());
    const cookie = rebound.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(body.accessToken);

    // The rebind itself ends the session that presented the link: the
    // throwaway Bearer is already dead before any client cleanup runs.
    const oldMe = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${second.accessToken}` },
    });
    expect(oldMe.status).toBe(401);
    // The client's own end-of-previous-session revoke (Bearer only, no
    // cookie) afterwards is a harmless no-op against the dead Bearer.
    const revoke = await app.request("/v1/principals/provisional/revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${second.accessToken}` },
    });
    expect([204, 401]).toContain(revoke.status);
    // The rebound session survives, by Bearer and by its cookie alike.
    const bearerMe = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(bearerMe.status).toBe(200);
    expect(overlapCast(await bearerMe.json()).id).toBe(first.principalId);
    const cookieMe = await app.request("/v1/principals/me", {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    expect(cookieMe.status).toBe(200);
    expect(overlapCast(await cookieMe.json()).id).toBe(first.principalId);
  });

  // Three signings and three link round-trips: give loaded CI room.
  it("still refuses a registered caller whose subject another principal owns", {
    timeout: 30_000,
  }, async () => {
    const { privateKey, jwks } = await mintKeys();
    orgAssertionSeams.discoverJwksUri = async () => `${ISSUER}/jwks`;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(jwks))),
    );
    const { app } = createControlPlane();
    const sign = (subject: string) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "claim-1" })
        .setIssuer(ISSUER)
        .setAudience("origin:http://127.0.0.1:8788")
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    const link = (bearer: string, idToken: string) =>
      app.request("/v1/principals/link-identities", {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ idToken }),
      });
    const first = await guest(app);
    const theirs = await sign("theirs@upstream");
    expect((await link(first.accessToken, theirs)).status).toBe(201);
    // A second principal with its own verified identity is registered, not
    // a throwaway: presenting the first subject is a collision, not a
    // rebind — merging two real accounts takes dual authentication.
    const second = await guest(app);
    expect(
      (await link(second.accessToken, await sign("mine@upstream"))).status,
    ).toBe(201);
    const refused = await link(second.accessToken, theirs);
    expect(refused.status).toBe(409);
    expect(overlapCast(await refused.json()).accessToken).toBeUndefined();
  });

  it("refuses a correctly signed token issued for another client without attaching identity", async () => {
    const { privateKey, jwks } = await mintKeys();
    orgAssertionSeams.discoverJwksUri = async () => `${ISSUER}/jwks`;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(jwks))),
    );
    const { app } = createControlPlane();
    const created = await guest(app);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "claim-1" })
      .setIssuer(ISSUER)
      .setAudience("origin:https://foreign.example")
      .setSubject("foreign@upstream")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const linked = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ idToken: token }),
    });
    expect(linked.status).toBe(401);
    const me = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${created.accessToken}` },
    });
    expect(overlapCast(await me.json()).assurance).toBe("provisional");
  });

  it("accepts a token whose issuer carries a legal trailing slash", async () => {
    const { privateKey, jwks } = await mintKeys();
    orgAssertionSeams.discoverJwksUri = async () => `${ISSUER}/jwks`;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(jwks))),
    );

    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
        trustedUpstreamIssuers: [ISSUER],
      },
    });
    const created = await guest(app);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "claim-1" })
      .setIssuer(`${ISSUER}/`)
      .setAudience("origin:http://127.0.0.1:8788")
      .setSubject("slash@upstream")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const linked = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ idToken: token }),
    });
    expect(linked.status).toBe(201);
    expect(overlapCast(await linked.json()).identity.issuer).toBe(ISSUER);
  });

  it("promotes the same principal when self-asserted links are off", async () => {
    const { privateKey, jwks } = await mintKeys();
    orgAssertionSeams.discoverJwksUri = async () =>
      "http://127.0.0.1:9090/jwks";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(jwks))),
    );

    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
        allowDevDefaults: false,
        claimPepper: "prod-claim-pepper-for-test-only",
        isProduction: false,
        trustedUpstreamIssuers: [ISSUER],
      },
      processEnv: {
        ...process.env,
        OPENSESAME_ALLOW_DEV_DEFAULTS: "0",
        OPENSESAME_CLAIM_PEPPER: "prod-claim-pepper-for-test-only",
        NODE_ENV: "development",
      },
    });
    const created = await guest(app);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "claim-1" })
      .setIssuer("http://127.0.0.1:9090")
      .setAudience("origin:http://127.0.0.1:8788")
      .setSubject("alice@upstream")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const linked = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ idToken: token }),
    });
    expect(linked.status).toBe(201);
    expect(overlapCast(await linked.json()).principalId).toBe(
      created.principalId,
    );

    const me = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${created.accessToken}` },
    });
    expect(overlapCast(await me.json())).toMatchObject({
      id: created.principalId,
      assurance: "verified",
    });
  });

  it("refuses an issuer that is not on the allowlist", async () => {
    const { app } = createControlPlane();
    const created = await guest(app);
    const token = [
      Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
        "base64url",
      ),
      Buffer.from(
        JSON.stringify({ iss: "https://evil.example", sub: "x" }),
      ).toString("base64url"),
      "sig",
    ].join(".");
    const linked = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ idToken: token }),
    });
    expect(linked.status).toBe(403);
    expect(overlapCast(await linked.json()).error).toBe("untrusted_issuer");
  });
});
