import { overlapCast } from "@opensesame/os-domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import vectors from "../../../../spec/auth-verification/decision-vectors.json" with {
  type: "json",
};
import type { AppContext } from "../context.js";
import {
  cookieAuthAllowed,
  resolveProvisionalSession,
} from "../middleware/auth.js";

type Principal = "absent" | "provisional" | "active" | "suspended" | "closed";

function alternate(index: number, period: number): boolean {
  return Math.floor(index / period) % 2 === 1;
}

function cookieContext(publicUrl: string, corsOrigins: string[]): AppContext {
  return overlapCast({ config: { publicUrl, corsOrigins } });
}

type SessionContextInput = {
  tokenMapped: boolean;
  sessionPresent: boolean;
  now: number;
  expiresAt: number;
  revoked: boolean;
  principal: Principal;
};

function sessionContext(input: SessionContextInput): AppContext {
  return overlapCast({
    clock: () => new Date(input.now),
    stores: {
      provisionalTokens: {
        get: () => (input.tokenMapped ? "ps_one" : undefined),
      },
      provisionalSessions: {
        get: () =>
          input.sessionPresent
            ? {
                id: "ps_one",
                principalId: "prn_one",
                expiresAt: new Date(input.expiresAt),
                revokedAt: input.revoked ? new Date(1) : undefined,
              }
            : undefined,
      },
      // No organization withdrawal is pending in these schedules.
      organizationMemberships: {
        hasPendingWithdrawalForPrincipal: async () => false,
      },
    },
    repos: {
      principals: {
        getById: () =>
          input.principal === "absent"
            ? null
            : { id: "prn_one", state: input.principal },
      },
    },
  });
}

describe("cookie-origin admission contract", () => {
  it("checks every realizable combination of safe, present, listed and same origin", () => {
    expect(vectors.cookie).toHaveLength(16);
    // Decode the same ordered Boolean product as DecisionVectors.lean.
    for (let vector = 0; vector < 16; vector++) {
      const safe = alternate(vector, 8);
      const present = alternate(vector, 4);
      const listed = alternate(vector, 2);
      const same = alternate(vector, 1);
      const origin = present ? "https://caller.example" : undefined;
      const ctx = cookieContext(
        same ? "https://caller.example/path" : "https://service.example",
        listed ? ["https://caller.example"] : [],
      );
      const actual = cookieAuthAllowed(ctx, safe ? "GET" : "POST", origin);
      expect(actual).toBe(vectors.cookie[vector] === "1");
    }
  });

  it("only admits generated unsafe origins when explicitly trusted", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/),
        fc.constantFrom("POST", "post", "PUT", "PATCH", "DELETE", "TRACE"),
        (label, method) => {
          const trusted = `https://${label}.example`;
          const unrelated = `https://${label}.example.attacker.test`;
          const ctx = cookieContext(`${trusted}/path`, [trusted]);
          expect(cookieAuthAllowed(ctx, method, trusted)).toBe(true);
          expect(cookieAuthAllowed(ctx, method, unrelated)).toBe(false);
          expect(cookieAuthAllowed(ctx, method, undefined)).toBe(false);
          expect(cookieAuthAllowed(ctx, method, "")).toBe(false);
        },
      ),
      { seed: 20261116, numRuns: 300 },
    );
  });

  it("accepts safe methods independent of origin, and fails closed on an invalid public URL", () => {
    const ctx = cookieContext("not a URL", []);
    for (const method of ["GET", "get", "HEAD", "head", "OPTIONS", "options"])
      expect(cookieAuthAllowed(ctx, method, undefined)).toBe(true);
    expect(cookieAuthAllowed(ctx, "POST", "https://unknown.example")).toBe(
      false,
    );
  });

  it("rejects an empty origin for unsafe requests even if the allowlist contains it", () => {
    const ctx = cookieContext("https://service.example", [""]);
    expect(cookieAuthAllowed(ctx, "POST", "")).toBe(false);
  });
});

describe("provisional session admission contract", () => {
  it("checks the full finite decision table, including the exclusive expiry boundary", async () => {
    const states: Principal[] = [
      "absent",
      "provisional",
      "active",
      "suspended",
      "closed",
    ];
    expect(vectors.session).toHaveLength(240);
    // The final principal dimension varies fastest, followed by revocation,
    // expiry, session, token mapping, and prefix.
    for (let vector = 0; vector < 240; vector++) {
      const principal = states[vector % states.length];
      const expiresAt = [999, 1000, 1001][Math.floor(vector / 10) % 3];
      if (principal === undefined || expiresAt === undefined)
        throw new Error("Invalid session vector index");
      const ctx = sessionContext({
        tokenMapped: alternate(vector, 60),
        sessionPresent: alternate(vector, 30),
        now: 1000,
        expiresAt,
        revoked: alternate(vector, 5),
        principal,
      });
      const token = alternate(vector, 120) ? "pst_one" : "ps_one";
      const accepted = vectors.session[vector] === "1";
      expect(await resolveProvisionalSession(ctx, token)).toEqual(
        accepted ? { principalId: "prn_one", sessionId: "ps_one" } : undefined,
      );
    }
  });

  it("preserves the contract across generated valid clock values", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom<Principal>(
          "absent",
          "provisional",
          "active",
          "suspended",
          "closed",
        ),
        fc.integer({ min: 1, max: 2_000_000_000 }),
        fc.integer({ min: -1000, max: 1000 }),
        async (
          prefix,
          tokenMapped,
          sessionPresent,
          revoked,
          principal,
          now,
          delta,
        ) => {
          const ctx = sessionContext({
            tokenMapped,
            sessionPresent,
            revoked,
            principal,
            now,
            expiresAt: now + delta,
          });
          const actual = await resolveProvisionalSession(
            ctx,
            prefix ? "pst_one" : "ps_one",
          );
          const eligible =
            prefix &&
            tokenMapped &&
            sessionPresent &&
            delta > 0 &&
            !revoked &&
            (principal === "active" || principal === "provisional");
          expect(actual).toEqual(
            eligible
              ? { principalId: "prn_one", sessionId: "ps_one" }
              : undefined,
          );
        },
      ),
      { seed: 20261116, numRuns: 1000 },
    );
  });
});
