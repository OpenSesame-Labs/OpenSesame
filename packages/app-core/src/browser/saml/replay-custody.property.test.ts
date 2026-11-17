import fc from "fast-check";
import { expect, it } from "vitest";
import type { SamlProtocolClaims } from "./assertion.js";
import { claimNativeSamlAssertion } from "./assertion-replay.js";

type Event =
  | { kind: "advance"; amount: number }
  | { kind: "claim"; issuer: "a" | "b"; id: "x" | "y"; offset: number };
type Entry = { issuer: string; id: string; expiry: number };
type Coverage = {
  accepted: number;
  replay: number;
  expired: number;
  reused: number;
  otherIssuer: number;
};

function claims(
  issuer: string,
  assertionId: string,
  validUntil: number,
): SamlProtocolClaims {
  return {
    protocol: "saml",
    issuer,
    assertionId,
    validUntil,
    audience: "audience",
    requestId: "request",
    responseId: "response",
    subject: "person",
    nameIdFormat: "",
    nameQualifier: "",
    spNameQualifier: "",
    authnContext: "",
    sessionIndex: "",
    authenticatedAt: 0,
    acceptedAt: 0,
    oneTimeUse: true,
  };
}

function attempt(
  issuer: string,
  id: string,
  expiry: number,
  now: number,
): boolean {
  try {
    claimNativeSamlAssertion(claims(issuer, id, expiry), now);
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

function exercise(events: Event[], base: number, coverage: Coverage) {
  let now = base;
  let active: Entry[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.kind === "advance") {
      now += event.amount;
      continue;
    }
    const issuer = `${base}-${event.issuer}`;
    const expiry = now + event.offset;
    active = active.filter((entry) => entry.expiry > now);
    const duplicate = active.some(
      (entry) => entry.issuer === issuer && entry.id === event.id,
    );
    const other = active.some(
      (entry) => entry.issuer !== issuer && entry.id === event.id,
    );
    const valid = expiry > now && !duplicate;
    expect(attempt(issuer, event.id, expiry, now)).toBe(valid);
    if (duplicate) coverage.replay++;
    if (expiry <= now) coverage.expired++;
    if (valid) {
      const key = `${event.issuer}:${event.id}`;
      if (seen.has(key)) coverage.reused++;
      if (other) coverage.otherIssuer++;
      seen.add(key);
      active.push({ issuer, id: event.id, expiry });
      coverage.accepted++;
    }
  }
}

it("matches replay, issuer, expiry and pruning rules across generated claim sequences", () => {
  let base = 10_000;
  const coverage: Coverage = {
    accepted: 0,
    replay: 0,
    expired: 0,
    reused: 0,
    otherIssuer: 0,
  };
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          fc.record({
            kind: fc.constant("advance" as const),
            amount: fc.constantFrom(1, 2, 3),
          }),
          fc.record({
            kind: fc.constant("claim" as const),
            issuer: fc.constantFrom("a", "b"),
            id: fc.constantFrom("x", "y"),
            offset: fc.constantFrom(-1, 0, 1, 2, 5),
          }),
        ),
        { minLength: 1, maxLength: 40 },
      ),
      (events: Event[]) => {
        base += 10_000;
        exercise(events, base, coverage);
      },
    ),
    { seed: 20261117, numRuns: 500 },
  );
  for (const [name, count] of Object.entries(coverage))
    expect(count, `generated cases must exercise ${name}`).toBeGreaterThan(0);
});

it("fails closed at capacity and frees entries at their exact expiry", () => {
  const now = 1_000_000_000_000;
  for (let index = 0; index < 1024; index++)
    expect(attempt("capacity-issuer", `id-${index}`, now + 10, now)).toBe(true);
  expect(attempt("capacity-issuer", "overflow", now + 10, now)).toBe(false);
  expect(attempt("capacity-issuer", "id-0", now + 10, now)).toBe(false);
  expect(attempt("capacity-issuer", "id-0", now + 11, now + 10)).toBe(true);
});
