import { overlapCast } from "@opensesame/os-domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { createControlPlane } from "../create-app.js";
import { resolveProvisionalSession } from "../middleware/auth.js";

type Change = {
  dropToken: boolean;
  dropSession: boolean;
  expire: boolean;
  revoke: boolean;
  suspend: boolean;
};
type Schedule = {
  before: Change;
  token: Change;
  session: Change;
  principal: Change;
};

function gate() {
  let arrive = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    async wait() {
      arrive();
      await waiting;
    },
  };
}

async function resolveWithSchedule(schedule: Schedule) {
  const state = {
    token: true,
    session: true,
    expired: false,
    revoked: false,
    suspended: false,
  };
  const tokenGate = gate();
  const sessionGate = gate();
  const principalGate = gate();
  const apply = (change: Change) => {
    state.token &&= !change.dropToken;
    state.session &&= !change.dropSession;
    state.expired ||= change.expire;
    state.revoked ||= change.revoke;
    state.suspended ||= change.suspend;
  };
  const ctx: AppContext = overlapCast({
    clock: () => new Date(1_000),
    stores: {
      provisionalTokens: {
        get: async () => {
          await tokenGate.wait();
          return state.token ? "ps_one" : undefined;
        },
      },
      provisionalSessions: {
        get: async () => {
          await sessionGate.wait();
          if (!state.session) return undefined;
          return {
            id: "ps_one",
            principalId: "prn_one",
            expiresAt: new Date(state.expired ? 1_000 : 2_000),
            revokedAt: state.revoked ? new Date(1) : undefined,
          };
        },
      },
      // No organization withdrawal is pending in these schedules.
      organizationMemberships: {
        hasPendingWithdrawalForPrincipal: async () => false,
      },
    },
    repos: {
      principals: {
        getById: async () => {
          await principalGate.wait();
          return {
            id: "prn_one",
            state: state.suspended ? "suspended" : "active",
          };
        },
      },
    },
  });

  apply(schedule.before);
  const result = resolveProvisionalSession(ctx, "pst_one");
  await tokenGate.entered;
  apply(schedule.token);
  const tokenAtRead = state.token;
  tokenGate.release();
  if (!tokenAtRead) return { result: await result, state };
  await sessionGate.entered;
  apply(schedule.session);
  const sessionAtRead = state.session && !state.expired && !state.revoked;
  sessionGate.release();
  if (sessionAtRead) {
    await principalGate.entered;
    apply(schedule.principal);
    principalGate.release();
  }
  return { result: await result, state };
}

const rare = fc.constantFrom(
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  true,
);
const change = fc.record({
  dropToken: rare,
  dropSession: rare,
  expire: rare,
  revoke: rare,
  suspend: rare,
});

function expectedStage(
  schedule: Schedule,
): "token" | "session" | "principal" | "accepted" {
  const tokenReads = [schedule.before, schedule.token];
  const sessionReads = [...tokenReads, schedule.session];
  const principalReads = [...sessionReads, schedule.principal];
  if (tokenReads.some((event) => event.dropToken)) return "token";
  if (
    sessionReads.some(
      (event) => event.dropSession || event.expire || event.revoke,
    )
  )
    return "session";
  if (principalReads.some((event) => event.suspend)) return "principal";
  return "accepted";
}

describe("provisional-session store interleavings", () => {
  it("uses the session and principal observations reached by each generated schedule", async () => {
    const coverage = {
      token: 0,
      session: 0,
      principal: 0,
      accepted: 0,
      lateRevocation: 0,
    };
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          before: change,
          token: change,
          session: change,
          principal: change,
        }),
        async (schedule) => {
          const observed = await resolveWithSchedule(schedule);
          const stage = expectedStage(schedule);
          coverage[stage] += 1;
          const accepted = stage === "accepted";
          if (accepted && schedule.principal.revoke)
            coverage.lateRevocation += 1;
          expect(observed.result).toEqual(
            accepted
              ? { principalId: "prn_one", sessionId: "ps_one" }
              : undefined,
          );
        },
      ),
      { seed: 20261117, numRuns: 200 },
    );
    for (const [name, count] of Object.entries(coverage))
      expect(count, `generated schedules must cover ${name}`).toBeGreaterThan(
        0,
      );
  });

  it("can finish an in-flight request when revocation follows its session read", async () => {
    const unchanged = {
      dropToken: false,
      dropSession: false,
      expire: false,
      revoke: false,
      suspend: false,
    };
    const observed = await resolveWithSchedule({
      before: unchanged,
      token: unchanged,
      session: unchanged,
      principal: { ...unchanged, revoke: true },
    });
    expect(observed.state.revoked).toBe(true);
    expect(observed.result).toEqual({
      principalId: "prn_one",
      sessionId: "ps_one",
    });
  });
});

describe("fresh guest admission", () => {
  it("a delayed sign-out response cannot clear a newer sign-in cookie", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const old = await app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const oldCookie = old.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    expect(oldCookie).toBeTruthy();
    const delivery = gate();
    const signOut = (async () => {
      const response = await app.request("/v1/principals/provisional/revoke", {
        method: "POST",
        headers: { cookie: oldCookie, origin: "http://127.0.0.1:8788" },
      });
      await delivery.wait();
      return response;
    })();
    await delivery.entered;
    const next = await app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const nextCookie = next.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    expect(nextCookie).toBeTruthy();
    delivery.release();
    const delayed = await signOut;
    expect(delayed.status).toBe(204);
    expect(delayed.headers.get("set-cookie")).toBeNull();
    expect(
      (
        await app.request("/v1/principals/me", {
          headers: { cookie: oldCookie },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/v1/principals/me", {
          headers: { cookie: nextCookie },
        })
      ).status,
    ).toBe(200);
  });

  it("mints a bearer without setting a cookie or replacing another session", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const member = await app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const memberCookie = member.headers.get("set-cookie")?.split(";", 1)[0];
    const memberBody = await member.json();
    expect(memberCookie).toBeTruthy();
    const guest = await app.request("/v1/principals/provisional", {
      method: "POST",
      headers: { "x-opensesame-fresh-guest": "1" },
    });
    expect(guest.status).toBe(201);
    expect(guest.headers.get("set-cookie")).toBeNull();
    const guestBody = await guest.json();
    expect(guestBody.principalId).not.toBe(memberBody.principalId);

    const bearer = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${guestBody.accessToken}` },
    });
    const cookie = await app.request("/v1/principals/me", {
      headers: { cookie: memberCookie ?? "" },
    });
    expect((await bearer.json()).id).toBe(guestBody.principalId);
    expect((await cookie.json()).id).toBe(memberBody.principalId);
  });

  it("sets no bound cookie for a fresh guest that also sends a restore proof", async () => {
    const origin = "http://127.0.0.1:8788";
    const { app } = createControlPlane({
      config: { port: 0, publicUrl: origin, issuer: origin },
    });
    const guest = await app.request("/v1/principals/provisional", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "x-opensesame-fresh-guest": "1",
      },
      body: JSON.stringify({ restoreProofHash: "a".repeat(64) }),
    });
    expect(guest.status).toBe(201);
    expect(guest.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a fresh guest request carrying even an invalid credential", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const first = await app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const cookieName = first.headers.get("set-cookie")?.split("=", 1)[0];
    expect(cookieName).toBeTruthy();
    for (const credential of [
      { cookie: `${cookieName}=expired` },
      { authorization: "Bearer invalid" },
    ]) {
      const response = await app.request("/v1/principals/provisional", {
        method: "POST",
        headers: { ...credential, "x-opensesame-fresh-guest": "1" },
      });
      expect(response.status).toBe(409);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("refuses a fresh guest mint when the request carries a live session cookie", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const first = await app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const cookie = first.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const guarded = await app.request("/v1/principals/provisional", {
      method: "POST",
      headers: {
        cookie: cookie ?? "",
        origin: "http://127.0.0.1:8788",
        "x-opensesame-fresh-guest": "1",
      },
    });

    expect(guarded.status).toBe(409);
    await expect(guarded.json()).resolves.toMatchObject({
      error: "fresh_guest_requires_sign_out",
    });
  });
});
