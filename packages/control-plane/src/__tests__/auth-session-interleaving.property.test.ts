import { overlapCast } from "@opensesame/os-domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
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
    // The boundary re-reads the token before the principal: a token dropped
    // this late resolves the request without ever consulting the principal,
    // so wait on the gate only if the flow actually reaches it.
    const reachedPrincipal = await Promise.race([
      principalGate.entered.then(() => true),
      result.then(() => false),
    ]);
    if (reachedPrincipal) {
      apply(schedule.principal);
      principalGate.release();
    }
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
  // Authentication re-reads the token inside the session boundary, after the
  // session-stage change has applied, so a token dropped as late as the
  // session stage is observed too.
  const tokenReads = [schedule.before, schedule.token, schedule.session];
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
