import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type ReferenceIdp,
  startReferenceIdp,
} from "@opensesame/mock-upstream-idp/testkit";
import { type JsonObject, isString, overlapCast } from "@opensesame/os-domain";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createControlPlane } from "../create-app.js";
import { principalSessionEpoch } from "../repos/principal-session-boundary.js";
import { saveProvisional } from "../repos/session-storage.js";
import {
  LOGOUT_TOKEN_MAX_AGE_SECONDS,
  resetBackchannelLogoutBudget,
} from "../routes/backchannel-logout.js";
import { attachVerifiedExternalIdentity } from "../services/identity-link.js";

/**
 * OIDC Back-Channel Logout (C17, D13).
 *
 * Every token here is signed by the reference IdP with keys it generated at
 * startup, and this endpoint fetches that IdP's real JWKS over a real socket to
 * check them. That is the whole point of the suite: the signature is the only
 * credential an unauthenticated session-revoking endpoint has.
 */

type App = ReturnType<typeof createControlPlane>["app"];

const PAGES_ORIGIN = "http://localhost:5180";
const LOGOUT_PATH = "/v1/federated/backchannel-logout";

let idp: ReferenceIdp;

beforeAll(async () => {
  resetBackchannelLogoutBudget();
  idp = await startReferenceIdp();
}, 30_000);

afterAll(async () => {
  await idp.close();
  resetBackchannelLogoutBudget();
});

beforeEach(() => {
  // The budget window and the JWKS cache outlive a request by design; a case
  // that inherited a previous one's spend would fail for the wrong reason.
  resetBackchannelLogoutBudget();
});

function staticConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
    trustedUpstreamIssuers: [idp.issuer],
    upstreamClientCredentials: {
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: "test-secret",
    },
  } as const;
}

/** No allowlist entry: the only thing that can vouch for the IdP is a tenant. */
function tenantOnlyConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
    trustedUpstreamIssuers: ["https://unrelated.example"],
    organizationIssuerAllowlist: [idp.issuer],
  } as const;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

function json(token: string) {
  return { ...auth(token), "content-type": "application/json" };
}

async function provisional(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
    headers: { "user-agent": `os-test-${randomBytes(6).toString("hex")}` },
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

/** A signed-in session whose identity is `(issuer, subject)`. */
async function signedIn(app: App, issuer: string, subject: string) {
  const session = await provisional(app);
  const linked = await app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: json(session.accessToken),
    body: JSON.stringify({
      kind: "oidc",
      issuer,
      subject,
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  return session;
}

function stillSignedIn(app: App, token: string) {
  return app
    .request("/v1/organizations", { headers: auth(token) })
    .then((res) => res.status === 200);
}

function postLogout(app: App, logoutToken: string) {
  return app.request(LOGOUT_PATH, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ logout_token: logoutToken }).toString(),
  });
}

/** A structurally valid JWT this deployment must refuse. */
function unsignedToken(issuer: string, subject: string): string {
  const part = (value: JsonObject) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    part({ alg: "RS256", kid: "not-a-key" }),
    part({
      iss: issuer,
      sub: subject,
      aud: "anyone",
      iat: Math.floor(Date.now() / 1000),
      events: { "http://schemas.openid.net/event/backchannel-logout": {} },
    }),
    "AAAA",
  ].join(".");
}

async function mintOrgIdToken(origin: string) {
  const clientId = `origin:${origin}`;
  const redirectUri = `${origin}/opensesame/callback`;
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${idp.issuer}/authorize`);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid email profile");
  authorize.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  authorize.searchParams.set("code_challenge_method", "S256");
  const redirected = await fetch(authorize, { redirect: "manual" });
  const code =
    new URL(redirected.headers.get("location") ?? "").searchParams.get(
      "code",
    ) ?? "";
  const tokens = await fetch(`${idp.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  const idToken = overlapCast(await tokens.json()).id_token;
  if (!isString(idToken)) throw new Error("no id_token minted");
  const [, payload] = idToken.split(".");
  const claims = overlapCast(
    JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")),
  );
  const subject = claims.pairwise_sub ?? claims.sub;
  if (!isString(subject)) throw new Error("no subject in id_token");
  return { idToken, subject };
}

describe("back-channel logout", () => {
  it("ends the subject's sessions and answers 200 with nothing", async () => {
    const { app } = createControlPlane({ config: staticConfig() });
    const session = await signedIn(app, idp.issuer, "mock-user-1");
    const bystander = await signedIn(app, idp.issuer, "someone-else");
    expect(await stillSignedIn(app, session.accessToken)).toBe(true);

    const res = await postLogout(
      app,
      await idp.mintBackchannelLogoutToken("mock-user-1"),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(await stillSignedIn(app, session.accessToken)).toBe(false);
    // Only that subject: a logout is not a mass sign-out.
    expect(await stillSignedIn(app, bystander.accessToken)).toBe(true);
  }, 30_000);

  it("resumes a claimed logout when the IdP retries after a crash", async () => {
    const { app, ctx } = createControlPlane({ config: staticConfig() });
    const session = await signedIn(app, idp.issuer, "crash-boundary-user");
    const token = await idp.mintBackchannelLogoutToken("crash-boundary-user");
    const claim = ctx.repos.callbackReplays.claim.bind(
      ctx.repos.callbackReplays,
    );
    let interrupted = false;
    vi.spyOn(ctx.repos.callbackReplays, "claim").mockImplementation(
      async (record) => {
        const result = await claim(record);
        if (!interrupted) {
          interrupted = true;
          throw new Error("process interrupted after replay claim");
        }
        return result;
      },
    );

    expect((await postLogout(app, token)).status).toBe(500);
    expect(await stillSignedIn(app, session.accessToken)).toBe(true);
    expect((await postLogout(app, token)).status).toBe(200);
    expect(await stillSignedIn(app, session.accessToken)).toBe(false);
  }, 30_000);

  it("completes concurrent deliveries once without losing revocation", async () => {
    const { app, ctx } = createControlPlane({ config: staticConfig() });
    const session = await signedIn(app, idp.issuer, "concurrent-logout-user");
    const token = await idp.mintBackchannelLogoutToken(
      "concurrent-logout-user",
    );

    const responses = await Promise.all([
      postLogout(app, token),
      postLogout(app, token),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await stillSignedIn(app, session.accessToken)).toBe(false);
    const operations = [
      ...(await ctx.stores.upstreamLogoutOperations.entries()),
    ];
    expect(operations).toHaveLength(1);
    expect(operations[0]?.[1].completed).toBe(true);
  }, 30_000);

  it("prunes completed journals before preparing the next logout", async () => {
    let now = Date.now();
    const { app, ctx } = createControlPlane({
      config: staticConfig(),
      clock: () => new Date(now),
    });
    await signedIn(app, idp.issuer, "journal-cleanup-user");
    expect(
      (
        await postLogout(
          app,
          await idp.mintBackchannelLogoutToken("journal-cleanup-user"),
        )
      ).status,
    ).toBe(200);
    const [completed] = [
      ...(await ctx.stores.upstreamLogoutOperations.entries()),
    ];
    if (!completed) throw new Error("Expected completed logout journal");
    now += (LOGOUT_TOKEN_MAX_AGE_SECONDS + 11) * 1000;

    expect(
      (
        await postLogout(
          app,
          await idp.mintBackchannelLogoutToken("nobody-new"),
        )
      ).status,
    ).toBe(200);
    const remaining = [
      ...(await ctx.stores.upstreamLogoutOperations.entries()),
    ];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.[0]).not.toBe(completed[0]);
  }, 30_000);

  it("revokes a session published after the durable authority snapshot", async () => {
    const { app, ctx } = createControlPlane({ config: staticConfig() });
    const session = await signedIn(app, idp.issuer, "overlap-logout-user");
    const current = [...(await ctx.stores.provisionalSessions.values())].find(
      (candidate) => candidate.principalId === session.principalId,
    );
    if (!current) throw new Error("Expected provisional session");
    const epoch = await principalSessionEpoch(ctx.stores, current.principalId);
    const lateSessionId = `ps_${randomUUID()}`;
    const claim = ctx.repos.callbackReplays.claim.bind(
      ctx.repos.callbackReplays,
    );
    let published = false;
    vi.spyOn(ctx.repos.callbackReplays, "claim").mockImplementation(
      async (record) => {
        if (!published) {
          published = true;
          await saveProvisional(
            ctx.stores,
            { ...current, id: lateSessionId },
            `pst_${randomUUID()}`,
            epoch,
          );
        }
        return claim(record);
      },
    );

    const token = await idp.mintBackchannelLogoutToken("overlap-logout-user");
    expect((await postLogout(app, token)).status).toBe(200);
    expect(
      (await ctx.stores.provisionalSessions.get(lateSessionId))?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(await stillSignedIn(app, session.accessToken)).toBe(false);
  }, 30_000);

  it("advances authority when the subject has no live session", async () => {
    const { app, ctx } = createControlPlane({ config: staticConfig() });
    const session = await signedIn(app, idp.issuer, "empty-logout-user");
    const current = [...(await ctx.stores.provisionalSessions.values())].find(
      (candidate) => candidate.principalId === session.principalId,
    );
    if (!current) throw new Error("Expected provisional session");
    expect(
      (
        await postLogout(
          app,
          await idp.mintBackchannelLogoutToken("empty-logout-user"),
        )
      ).status,
    ).toBe(200);
    const staleEpoch = await principalSessionEpoch(
      ctx.stores,
      current.principalId,
    );

    expect(
      (
        await postLogout(
          app,
          await idp.mintBackchannelLogoutToken("empty-logout-user"),
        )
      ).status,
    ).toBe(200);
    await expect(
      saveProvisional(
        ctx.stores,
        { ...current, id: `ps_${randomUUID()}`, revokedAt: undefined },
        `pst_${randomUUID()}`,
        staleEpoch,
      ),
    ).rejects.toThrow(/session authority changed/i);
  }, 30_000);

  it("refuses a logout token carrying a nonce, and leaves the session alone", async () => {
    const { app } = createControlPlane({ config: staticConfig() });
    const session = await signedIn(app, idp.issuer, "mock-user-1");

    const res = await postLogout(
      app,
      await idp.mintBackchannelLogoutToken("mock-user-1", {
        includeNonce: true,
      }),
    );

    // The spec forbids `nonce` here precisely so a captured id_token cannot be
    // replayed as a logout instruction (T29).
    expect(res.status).toBe(400);
    expect(overlapCast(await res.json()).error).toBe("invalid_request");
    expect(await stillSignedIn(app, session.accessToken)).toBe(true);
  }, 30_000);

  it("answers an unmatched subject exactly as it answers a matched one", async () => {
    const { app } = createControlPlane({ config: staticConfig() });
    await signedIn(app, idp.issuer, "mock-user-1");

    const matched = await postLogout(
      app,
      await idp.mintBackchannelLogoutToken("mock-user-1"),
    );
    const unmatched = await postLogout(
      app,
      await idp.mintBackchannelLogoutToken("nobody-here"),
    );

    expect(unmatched.status).toBe(matched.status);
    expect(await unmatched.text()).toBe(await matched.text());
    expect(unmatched.status).toBe(200);
  }, 30_000);

  it("refuses an issuer nothing vouches for", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
        trustedUpstreamIssuers: ["https://somewhere-else.example"],
      },
    });
    const session = await signedIn(app, idp.issuer, "mock-user-1");

    const res = await postLogout(
      app,
      await idp.mintBackchannelLogoutToken("mock-user-1"),
    );
    expect(res.status).toBe(400);
    expect(await stillSignedIn(app, session.accessToken)).toBe(true);
  }, 30_000);

  it("refuses a token whose signature does not verify", async () => {
    const { app } = createControlPlane({ config: staticConfig() });
    const session = await signedIn(app, idp.issuer, "mock-user-1");

    const res = await postLogout(app, unsignedToken(idp.issuer, "mock-user-1"));
    expect(res.status).toBe(400);
    expect(await stillSignedIn(app, session.accessToken)).toBe(true);
  }, 30_000);

  it("refuses a token minted for another audience", async () => {
    const { app } = createControlPlane({ config: staticConfig() });
    const session = await signedIn(app, idp.issuer, "mock-user-1");

    const res = await postLogout(
      app,
      await idp.mintBackchannelLogoutToken("mock-user-1", {
        audience: "https://some-other-client.example",
      }),
    );
    expect(res.status).toBe(400);
    expect(await stillSignedIn(app, session.accessToken)).toBe(true);
  }, 30_000);

  it("refuses an empty or absent logout_token", async () => {
    const { app } = createControlPlane({ config: staticConfig() });
    const empty = await app.request(LOGOUT_PATH, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(empty.status).toBe(400);
  });

  it("ends sessions but preserves the memberships the issuing tenant granted", async () => {
    const { app, ctx } = createControlPlane({ config: tenantOnlyConfig() });
    // The owner's own identity is unrelated to the tenant's IdP.
    const owner = await signedIn(app, "https://mock.example", "tenant-owner");
    const created = await app.request("/v1/organizations", {
      method: "POST",
      headers: json(owner.accessToken),
      body: JSON.stringify({
        slug: "acme",
        displayName: "Acme",
      }),
    });
    expect(created.status).toBe(201);
    const org = overlapCast(await created.json());
    ctx.config.organizationIssuerAllowlist = [`${org.id}|${idp.issuer}`];
    expect(
      (
        await app.request(`/v1/organizations/${org.id}`, {
          method: "PATCH",
          headers: json(owner.accessToken),
          body: JSON.stringify({ ssoIssuer: idp.issuer }),
        })
      ).status,
    ).toBe(200);

    const { idToken, subject } = await mintOrgIdToken(PAGES_ORIGIN);
    const guest = await provisional(app);
    const joined = await app.request("/v1/organizations/tenants/acme/join", {
      method: "POST",
      headers: json(guest.accessToken),
      body: JSON.stringify({ method: "sso", idToken }),
    });
    expect(joined.status).toBe(201);

    const saml = await provisional(app);
    const otherTenant = await provisional(app);
    for (const [session, tenant] of [
      [saml, org.id],
      [otherTenant, "org:other"],
    ]) {
      expect(
        (
          await attachVerifiedExternalIdentity(ctx, session.principalId, {
            kind: "saml",
            issuer: idp.issuer,
            subject,
            tenant,
            correlationId: "tenant-scoped-logout",
          })
        ).ok,
      ).toBe(true);
    }
    await ctx.stores.organizationMemberships.upsert({
      organizationId: org.id,
      principalId: saml.principalId,
      role: "member",
      createdAt: ctx.clock(),
      updatedAt: ctx.clock(),
    });

    const res = await postLogout(
      app,
      await idp.mintBackchannelLogoutToken(subject, {
        audience: "http://127.0.0.1:8788",
      }),
    );
    expect(res.status).toBe(200);

    expect(
      await ctx.stores.organizationMemberships.find(org.id, guest.principalId),
    ).toMatchObject({ role: "member" });
    expect(await stillSignedIn(app, guest.accessToken)).toBe(false);
    expect(await stillSignedIn(app, saml.accessToken)).toBe(false);
    expect(await stillSignedIn(app, otherTenant.accessToken)).toBe(true);
    expect(
      await ctx.stores.organizationMemberships.find(org.id, saml.principalId),
    ).toMatchObject({ role: "member" });
  }, 30_000);

  it("rate-limits the endpoint and records no token material", async () => {
    const { app, ctx } = createControlPlane({ config: staticConfig() });
    const logoutToken = await idp.mintBackchannelLogoutToken("mock-user-1");
    expect((await postLogout(app, logoutToken)).status).toBe(200);

    // Same issuer, refused tokens: the budget is charged before the signature
    // check, because the signature check is the expensive part.
    let limited = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const res = await postLogout(
        app,
        unsignedToken(idp.issuer, "mock-user-1"),
      );
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);

    const trail = JSON.stringify(
      await ctx.repos.auditEvents.list({ limit: 200 }),
    );
    expect(trail).toContain("principal.upstream_logout");
    expect(trail).not.toContain(logoutToken);
    expect(trail).not.toContain(logoutToken.split(".")[2]);
  }, 30_000);
});
