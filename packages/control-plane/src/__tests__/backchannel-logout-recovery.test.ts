import { randomBytes, randomUUID } from "node:crypto";
import {
  type ReferenceIdp,
  startReferenceIdp,
} from "@opensesame/mock-upstream-idp/testkit";
import { overlapCast } from "@opensesame/os-domain";
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

/**
 * OIDC Back-Channel Logout (C17, D13).
 *
 * Every token here is signed by the reference IdP with keys it generated at
 * startup, and this endpoint fetches that IdP's real JWKS over a real socket to
 * check them. That is the whole point of the suite: the signature is the only
 * credential an unauthenticated session-revoking endpoint has.
 */

type App = ReturnType<typeof createControlPlane>["app"];

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
});
