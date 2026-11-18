import {
  type ChallengePurpose,
  type PasskeyAssertion,
  type PasskeyCredential,
  createMemoryChallengeStore,
  createSimpleWebAuthnVerifyFn,
  simpleWebAuthnSeams,
} from "@opensesame/auth-upstream";
import { overlapCast } from "@opensesame/os-domain";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";

type Person = "alice" | "bob";
type Attempt = {
  input: "issued" | "foreign" | "malformed";
  purpose:
    | "authentication"
    | "transaction"
    | "registration"
    | "other"
    | undefined;
  principal: Person;
};
type Scenario = {
  issued: ChallengePurpose;
  owner: Person | null;
  offset: number;
  signed: boolean;
  first: Attempt;
  second: Attempt;
};
type Coverage = {
  accepted: number;
  mismatch: number;
  invalidPurpose: number;
  expired: number;
  foreignFirst: number;
};

const rp = { rpID: "example.test", origin: "https://example.test" };
const attempt = fc.record({
  input: fc.constantFrom("issued", "foreign", "malformed"),
  purpose: fc.constantFrom(
    undefined,
    "authentication",
    "transaction",
    "registration",
    "other",
  ),
  principal: fc.constantFrom("alice", "bob"),
});

function assertion(input: Attempt): PasskeyAssertion {
  const encoded =
    input.input === "malformed"
      ? "{"
      : JSON.stringify({
          challenge: input.input === "issued" ? "issued" : "foreign",
        });
  // A runtime boundary can receive values that do not satisfy TypeScript types.
  return overlapCast({
    credentialId: "credential",
    clientDataJSON: new TextEncoder().encode(encoded),
    authenticatorData: new Uint8Array([0]),
    signature: new Uint8Array([1]),
    expectedPurpose: input.purpose,
  });
}

function credential(principalId: Person): PasskeyCredential {
  return {
    credentialId: "credential",
    publicKey: new Uint8Array([1]),
    counter: 0,
    principalId,
  };
}

function eligible(scenario: Scenario, current: Attempt): boolean {
  const wanted = current.purpose ?? "authentication";
  return (
    scenario.offset >= 0 &&
    (wanted === "authentication" || wanted === "transaction") &&
    wanted === scenario.issued &&
    (scenario.owner === null || scenario.owner === current.principal)
  );
}

function recordCoverage(
  scenario: Scenario,
  coverage: Coverage,
  winner: number,
  mayCheck: boolean,
  expected: boolean[],
) {
  const selected = winner === 0 ? scenario.first : scenario.second;
  if (expected.some(Boolean)) coverage.accepted++;
  if (winner >= 0 && !mayCheck && scenario.offset >= 0) coverage.mismatch++;
  if (
    winner >= 0 &&
    (selected.purpose === "registration" || selected.purpose === "other")
  )
    coverage.invalidPurpose++;
  if (winner >= 0 && scenario.offset < 0) coverage.expired++;
  if (winner === 1) coverage.foreignFirst++;
}

function expectation(scenario: Scenario, coverage: Coverage) {
  const winner =
    scenario.first.input === "issued"
      ? 0
      : scenario.second.input === "issued"
        ? 1
        : -1;
  const selected = winner === 0 ? scenario.first : scenario.second;
  const mayCheck = winner >= 0 && eligible(scenario, selected);
  const expected = [false, false];
  if (mayCheck && scenario.signed) expected[winner] = true;
  recordCoverage(scenario, coverage, winner, mayCheck, expected);
  return { winner, mayCheck, expected };
}

afterEach(() => vi.restoreAllMocks());

it("consumes one challenge across concurrent attempts and preserves purpose, principal and expiry binding", async () => {
  const now = 10_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  const verifySignature = vi.spyOn(
    simpleWebAuthnSeams,
    "verifyAuthenticationResponse",
  );
  const coverage = {
    accepted: 0,
    mismatch: 0,
    invalidPurpose: 0,
    expired: 0,
    foreignFirst: 0,
  };
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        issued: fc.constantFrom(
          "authentication",
          "transaction",
          "registration",
        ),
        owner: fc.constantFrom(null, "alice", "bob"),
        offset: fc.constantFrom(-1, 0, 1),
        signed: fc.boolean(),
        first: attempt,
        second: attempt,
      }),
      async (scenario) => {
        const store = createMemoryChallengeStore();
        store.set("issued", {
          principalId: scenario.owner,
          purpose: scenario.issued,
          expiresAt: now + scenario.offset,
        });
        verifySignature.mockReset();
        verifySignature.mockResolvedValue(
          overlapCast({
            verified: scenario.signed,
            authenticationInfo: { newCounter: 1 },
          }),
        );
        const verify = createSimpleWebAuthnVerifyFn(rp, store);
        const first = verify(
          assertion(scenario.first),
          credential(scenario.first.principal),
        );
        const second = verify(
          assertion(scenario.second),
          credential(scenario.second.principal),
        );
        const actual = await Promise.all([first, second]);
        const { winner, mayCheck, expected } = expectation(scenario, coverage);
        expect(actual.map((result) => result !== false && result.ok)).toEqual(
          expected,
        );
        expect(verifySignature).toHaveBeenCalledTimes(mayCheck ? 1 : 0);
        if (mayCheck) {
          expect(verifySignature).toHaveBeenCalledWith(
            expect.objectContaining({
              expectedChallenge: "issued",
              expectedOrigin: rp.origin,
              expectedRPID: rp.rpID,
              requireUserVerification: true,
            }),
          );
        }
        if (winner >= 0) expect(store.peek("issued")).toBeUndefined();
      },
    ),
    { seed: 20261117, numRuns: 300 },
  );
  for (const [name, count] of Object.entries(coverage))
    expect(count, `generated cases must exercise ${name}`).toBeGreaterThan(0);
});
