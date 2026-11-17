import {
  type ClaimSession,
  type ClaimState,
  DomainError,
  authenticateClaim,
  completeClaim,
  denyClaim,
  expireClaim,
  maybeExpireClaim,
  presentClaim,
  reviewClaim,
  revokeClaim,
} from "@opensesame/os-domain";
import fc from "fast-check";
import { expect, it } from "vitest";

type Operation =
  | "present"
  | "authenticate"
  | "review"
  | "complete"
  | "deny"
  | "revoke"
  | "expire"
  | "maybe";
type Event = { operation: Operation; at: number; actor: "" | "alice" | "bob" };
type Prediction = {
  state: ClaimState;
  changed: boolean;
  error?: "EXPIRED" | "INVALID_TRANSITION" | "INVARIANT_VIOLATION";
};
type Coverage = {
  reviewed: number;
  completed: number;
  denied: number;
  revoked: number;
  expired: number;
  late: number;
  emptyIdentityRejected: number;
};

const deadline = 4_000;
const terminal: ClaimState[] = ["completed", "denied", "revoked", "expired"];
type ClaimGraph = Record<ClaimState, ClaimState[]>;
type ClaimTargets = Record<Exclude<Operation, "maybe">, ClaimState>;
type TrackedState = "reviewed" | "completed" | "denied" | "revoked" | "expired";
const graph = {
  pending: ["presented", "revoked", "expired"],
  presented: ["authenticated", "revoked", "expired"],
  authenticated: ["reviewed", "revoked", "expired"],
  reviewed: ["completed", "denied", "revoked", "expired"],
  completed: [],
  denied: [],
  revoked: [],
  expired: [],
} satisfies ClaimGraph;
const targets = {
  present: "presented",
  authenticate: "authenticated",
  review: "reviewed",
  complete: "completed",
  deny: "denied",
  revoke: "revoked",
  expire: "expired",
} satisfies ClaimTargets;

function tracked(state: ClaimState): state is TrackedState {
  return (
    state === "reviewed" ||
    state === "completed" ||
    state === "denied" ||
    state === "revoked" ||
    state === "expired"
  );
}

function predict(state: ClaimState, event: Event): Prediction {
  if (event.operation === "maybe") {
    const expired = !terminal.includes(state) && event.at >= deadline;
    return { state: expired ? "expired" : state, changed: expired };
  }
  if (
    event.operation !== "expire" &&
    event.operation !== "revoke" &&
    (state === "expired" || (event.at >= deadline && !terminal.includes(state)))
  )
    return { state, changed: false, error: "EXPIRED" };
  const target = targets[event.operation];
  if (!graph[state].some((allowed) => allowed === target))
    return { state, changed: false, error: "INVALID_TRANSITION" };
  if (event.operation === "complete" && !event.actor)
    return { state, changed: false, error: "INVARIANT_VIOLATION" };
  return { state: target, changed: true };
}

function invoke(value: ClaimSession, event: Event): ClaimSession {
  const now = new Date(event.at);
  switch (event.operation) {
    case "present":
      return presentClaim(value, now);
    case "authenticate":
      return authenticateClaim(value, now);
    case "review":
      return reviewClaim(value, { accepted: true }, now);
    case "complete":
      return completeClaim(value, event.actor, now);
    case "deny":
      return denyClaim(value, now);
    case "revoke":
      return revokeClaim(value, now);
    case "expire":
      return expireClaim(value, now);
    case "maybe":
      return maybeExpireClaim(value, () => now);
  }
}

function initial(): ClaimSession {
  return {
    id: "claim",
    type: "resource_bundle",
    state: "pending",
    tokenDigest: new Uint8Array([1]),
    targetManifest: { targets: ["resource"] },
    targetManifestDigest: "manifest-digest",
    createdAt: new Date(1_000),
    expiresAt: new Date(deadline),
    version: 1,
  };
}

function applyEvent(
  value: ClaimSession,
  event: Event,
  coverage: Coverage,
): ClaimSession {
  const before = structuredClone(value);
  const expected = predict(value.state, event);
  let result: ClaimSession | undefined;
  let failure: unknown;
  try {
    result = invoke(value, event);
  } catch (error) {
    failure = error;
  }
  expect(value).toEqual(before);
  if (expected.error) {
    expect(failure).toBeInstanceOf(DomainError);
    if (!(failure instanceof DomainError))
      throw new Error("Expected a domain error");
    expect(failure.code).toBe(expected.error);
    if (expected.error === "EXPIRED") coverage.late++;
    if (
      event.operation === "complete" &&
      !event.actor &&
      expected.error === "INVARIANT_VIOLATION"
    )
      coverage.emptyIdentityRejected++;
    return value;
  }
  expect(failure).toBeUndefined();
  if (!result) throw new Error("Expected a claim result");
  expect(result.state).toBe(expected.state);
  expect(result.version).toBe(before.version + Number(expected.changed));
  expect(result.id).toBe(before.id);
  expect(result.tokenDigest).toEqual(before.tokenDigest);
  expect(result.targetManifestDigest).toBe(before.targetManifestDigest);
  expect(result.targetManifest).toEqual(before.targetManifest);
  if (expected.changed && tracked(result.state)) coverage[result.state]++;
  if (event.operation === "complete" && expected.changed) {
    expect(result.completedByPrincipalId).toBe(event.actor);
  }
  return result;
}

const early = (
  operation: Operation,
  actor: Event["actor"] = "alice",
): Event => ({ operation, actor, at: 3_999 });
const prefixes: Event[][] = [
  [],
  [early("present"), early("authenticate"), early("review")],
  [
    early("present"),
    early("authenticate"),
    early("review"),
    early("complete", ""),
    early("complete", "alice"),
  ],
  [early("present"), early("authenticate"), early("review"), early("deny")],
];

it("preserves claim binding, version and terminal rules across generated lifecycle sequences", () => {
  const coverage: Coverage = {
    reviewed: 0,
    completed: 0,
    denied: 0,
    revoked: 0,
    expired: 0,
    late: 0,
    emptyIdentityRejected: 0,
  };
  fc.assert(
    fc.property(
      fc.constantFrom(...prefixes),
      fc.array(
        fc.record({
          operation: fc.constantFrom(
            "present",
            "authenticate",
            "review",
            "complete",
            "deny",
            "revoke",
            "expire",
            "maybe",
          ),
          at: fc.constantFrom(3_999, 4_000, 4_001),
          actor: fc.constantFrom("", "alice", "bob"),
        }),
        { minLength: 1, maxLength: 25 },
      ),
      (prefix, suffix) => {
        let value = initial();
        for (const event of [...prefix, ...suffix])
          value = applyEvent(value, event, coverage);
      },
    ),
    { seed: 20261117, numRuns: 500 },
  );
  for (const [name, count] of Object.entries(coverage))
    expect(count, `generated cases must exercise ${name}`).toBeGreaterThan(0);
});
