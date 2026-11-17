import { webcrypto } from "node:crypto";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import vectors from "../../../../../spec/auth-verification/decision-vectors.json" with {
  type: "json",
};
import { prepareConfiguredOidc } from "./transaction.js";

const issuer = "https://idp.example.test";

function alternate(index: number, period: number): boolean {
  return Math.floor(index / period) % 2 === 1;
}

async function transaction() {
  let exchanges = 0;
  const controller = new AbortController();
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === `${issuer}/.well-known/openid-configuration`) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (String(input) === `${issuer}/token`) {
      exchanges++;
      throw new Error("Synthetic token exchange stopped");
    }
    throw new Error("Unexpected request");
  };
  const owner = { signal: controller.signal, assertCurrent: () => undefined };
  const transport = { fetch: fetchImpl, assertCurrent: () => undefined };
  const attempt = await prepareConfiguredOidc(
    {
      issuer,
      clientId: "test-client",
      clientSecret: "",
      scope: "openid",
      organization: null,
    },
    "https://app.example.test/native-return",
    transport,
    owner,
  );
  return { attempt, exchanges: () => exchanges, controller };
}

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("configured OIDC response binding", () => {
  it("matches all Lean decision vectors for the response gate", async () => {
    const now = vi.spyOn(Date, "now");
    expect(vectors.oidc).toHaveLength(128);
    // Decode the Boolean product in DecisionVectors.lean, last field fastest.
    for (let vector = 0; vector < 128; vector++) {
      const spent = alternate(vector, 64);
      const current = alternate(vector, 32);
      const inTime = alternate(vector, 16);
      const matching = alternate(vector, 8);
      const error = alternate(vector, 4);
      const hasCode = alternate(vector, 2);
      const bounded = alternate(vector, 1);
      now.mockReturnValue(1_000_000);
      const { attempt, exchanges, controller } = await transaction();
      if (spent)
        await expect(
          attempt.complete({
            state: `${attempt.state}.`,
            error: false,
            code: "code",
          }),
        ).rejects.toThrow();
      if (!current) controller.abort();
      if (!inTime) now.mockReturnValue(attempt.expiresAt);
      await expect(
        attempt.complete({
          state: matching ? attempt.state : `${attempt.state}.`,
          error,
          code: hasCode ? (bounded ? "code" : "x".repeat(4097)) : null,
        }),
      ).rejects.toThrow();
      expect(exchanges()).toBe(vectors.oidc[vector] === "1" ? 1 : 0);
    }
  });

  it("never exchanges an invalid response and consumes even a failed attempt", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("state", "error", "missing", "empty", "oversized"),
        fc.string({ maxLength: 30 }),
        async (defect, suffix) => {
          const { attempt, exchanges } = await transaction();
          const response = {
            state:
              defect === "state" ? `${attempt.state}.${suffix}` : attempt.state,
            error: defect === "error",
            code:
              defect === "missing"
                ? null
                : defect === "empty"
                  ? ""
                  : defect === "oversized"
                    ? "x".repeat(4097)
                    : "code",
          };
          await expect(attempt.complete(response)).rejects.toThrow();
          expect(exchanges()).toBe(0);
          await expect(
            attempt.complete({
              state: attempt.state,
              error: false,
              code: "code",
            }),
          ).rejects.toThrow(/already consumed/);
          expect(exchanges()).toBe(0);
        },
      ),
      { seed: 20261116, numRuns: 100 },
    );
  });

  it("denies an exactly expired transaction before any token request", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const { attempt, exchanges } = await transaction();
    now.mockReturnValue(attempt.expiresAt);
    await expect(
      attempt.complete({ state: attempt.state, error: false, code: "code" }),
    ).rejects.toThrow(/expired/);
    expect(exchanges()).toBe(0);
    await expect(
      attempt.complete({ state: attempt.state, error: false, code: "code" }),
    ).rejects.toThrow(/already consumed/);
  });

  it("allows at most one simultaneous token-exchange attempt", async () => {
    const { attempt, exchanges } = await transaction();
    const response = { state: attempt.state, error: false, code: "code" };
    const outcomes = await Promise.allSettled([
      attempt.complete(response),
      attempt.complete(response),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(
      true,
    );
    expect(exchanges()).toBe(1);
    expect(
      outcomes.some(
        (outcome) =>
          outcome.status === "rejected" &&
          /already consumed/.test(String(outcome.reason)),
      ),
    ).toBe(true);
  });
});
