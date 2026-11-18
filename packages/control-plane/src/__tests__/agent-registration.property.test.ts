import {
  type AgentRegistration,
  type AgentRegistrationStatus,
  DomainError,
  claimAgentRegistration,
  markAgentRegistrationClaimPending,
  markAgentRegistrationExpired,
  revokeAgentRegistration,
} from "@opensesame/os-domain";
import fc from "fast-check";
import { expect, it } from "vitest";

type Operation = "pending" | "claim" | "expire" | "revoke";
type Event = { operation: Operation; at: number; actor: "" | "alice" | "bob" };
type Prediction = {
  status: AgentRegistrationStatus;
  changed: boolean;
  error?: "EXPIRED" | "INVALID_TRANSITION" | "INVARIANT_VIOLATION";
};
type Coverage = {
  claimed: number;
  revoked: number;
  expired: number;
  retry: number;
  late: number;
  invalidActor: number;
  lateRevoke: number;
};
const deadline = 4_000;

function predictTerminal(
  status: AgentRegistrationStatus,
  event: Event,
): Prediction | undefined {
  const same = { status, changed: false };
  if (event.operation === "expire") {
    if (status === "expired") return same;
    if (status === "claimed" || status === "revoked")
      return { ...same, error: "INVALID_TRANSITION" };
    if (event.at < deadline) return { ...same, error: "INVARIANT_VIOLATION" };
    return { status: "expired", changed: true };
  }
  if (event.operation === "revoke") {
    if (status === "revoked") return same;
    if (status === "expired") return { ...same, error: "INVALID_TRANSITION" };
    return { status: "revoked", changed: true };
  }
  return undefined;
}

function predict(status: AgentRegistrationStatus, event: Event): Prediction {
  const terminal = predictTerminal(status, event);
  if (terminal) return terminal;
  const same = { status, changed: false };
  if (
    status === "expired" ||
    status === "revoked" ||
    (status !== "claimed" && event.at >= deadline)
  )
    return { ...same, error: "EXPIRED" };
  if (event.operation === "claim" && !event.actor)
    return { ...same, error: "INVARIANT_VIOLATION" };
  if (
    event.operation === "pending" &&
    (status === "unclaimed" || status === "claim_pending")
  )
    return { status: "claim_pending", changed: true };
  if (event.operation === "claim" && status === "claim_pending")
    return { status: "claimed", changed: true };
  return { ...same, error: "INVALID_TRANSITION" };
}

function invoke(value: AgentRegistration, event: Event): AgentRegistration {
  const now = new Date(event.at);
  switch (event.operation) {
    case "pending":
      return markAgentRegistrationClaimPending(value, now);
    case "claim":
      return claimAgentRegistration(value, event.actor, now);
    case "expire":
      return markAgentRegistrationExpired(value, now);
    case "revoke":
      return revokeAgentRegistration(value, now);
  }
}

function initial(): AgentRegistration {
  return {
    id: "registration",
    kind: "anonymous",
    status: "unclaimed",
    principalId: "original",
    createdAt: new Date(1_000),
    expiresAt: new Date(deadline),
    preClaimScopes: [],
    postClaimScopes: [],
    assertionVersion: 1,
    version: 1,
  };
}

function record(
  coverage: Coverage,
  before: AgentRegistration,
  event: Event,
  outcome: AgentRegistration,
) {
  if (outcome.status !== before.status && outcome.status === "claimed")
    coverage.claimed++;
  if (outcome.status !== before.status && outcome.status === "revoked")
    coverage.revoked++;
  if (outcome.status !== before.status && outcome.status === "expired")
    coverage.expired++;
  if (event.operation === "pending" && before.status === "claim_pending")
    coverage.retry++;
  if (
    event.operation === "revoke" &&
    before.status === "claimed" &&
    event.at >= deadline
  )
    coverage.lateRevoke++;
}

function applyEvent(
  value: AgentRegistration,
  event: Event,
  coverage: Coverage,
): AgentRegistration {
  const before = structuredClone(value);
  const expected = predict(value.status, event);
  let outcome: AgentRegistration | undefined;
  let failure: unknown;
  try {
    outcome = invoke(value, event);
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
      event.operation === "claim" &&
      !event.actor &&
      expected.error === "INVARIANT_VIOLATION"
    )
      coverage.invalidActor++;
    return value;
  }
  expect(failure).toBeUndefined();
  if (!outcome) throw new Error("Expected a registration result");
  expect(outcome.status).toBe(expected.status);
  expect(outcome.id).toBe(before.id);
  expect(outcome.kind).toBe(before.kind);
  expect(outcome.createdAt).toEqual(before.createdAt);
  expect(outcome.version).toBe(before.version + Number(expected.changed));
  const claim = event.operation === "claim" && expected.changed;
  expect(outcome.assertionVersion).toBe(
    before.assertionVersion + Number(claim),
  );
  expect(outcome.principalId).toBe(claim ? event.actor : before.principalId);
  expect(outcome.claimedByPrincipalId).toBe(
    claim ? event.actor : before.claimedByPrincipalId,
  );
  record(coverage, before, event, outcome);
  return outcome;
}

it("preserves registration ownership, expiry, revocation and version rules across generated sequences", () => {
  const coverage: Coverage = {
    claimed: 0,
    revoked: 0,
    expired: 0,
    retry: 0,
    late: 0,
    invalidActor: 0,
    lateRevoke: 0,
  };
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          operation: fc.constantFrom("pending", "claim", "expire", "revoke"),
          at: fc.constantFrom(3_999, 4_000, 4_001),
          actor: fc.constantFrom("", "alice", "bob"),
        }),
        { minLength: 1, maxLength: 25 },
      ),
      (events) => {
        let value = initial();
        for (const event of events) value = applyEvent(value, event, coverage);
      },
    ),
    { seed: 20261117, numRuns: 600 },
  );
  for (const [name, count] of Object.entries(coverage))
    expect(count, `generated cases must exercise ${name}`).toBeGreaterThan(0);
});
