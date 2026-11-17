import {
  type DeviceAuthorizationSession,
  type DeviceAuthorizationState,
  DomainError,
  approveDeviceAuth,
  consumeDeviceAuth,
  denyDeviceAuth,
  expireDeviceAuth,
  maybeExpireDeviceAuth,
  recordDevicePoll,
} from "@opensesame/os-domain";
import fc from "fast-check";
import { expect, it } from "vitest";

type Operation = "approve" | "deny" | "consume" | "expire" | "maybe" | "poll";
type Event = { operation: Operation; at: number; actor: "alice" | "bob" };
type Prediction = {
  state: DeviceAuthorizationState;
  error?: "EXPIRED" | "INVALID_TRANSITION";
};

const deadline = 4_000;
const terminals: DeviceAuthorizationState[] = ["denied", "consumed", "expired"];
type DeviceGraph = Record<DeviceAuthorizationState, DeviceAuthorizationState[]>;
type DeviceTargets = Record<
  Exclude<Operation, "poll" | "maybe">,
  DeviceAuthorizationState
>;
const graph = {
  pending: ["approved", "denied", "expired"],
  approved: ["consumed", "expired"],
  denied: [],
  consumed: [],
  expired: [],
} satisfies DeviceGraph;
const targets = {
  approve: "approved",
  deny: "denied",
  consume: "consumed",
  expire: "expired",
} satisfies DeviceTargets;

function predict(state: DeviceAuthorizationState, event: Event): Prediction {
  if (event.operation === "poll") return { state };
  if (event.operation === "maybe")
    return {
      state:
        !terminals.includes(state) && event.at >= deadline ? "expired" : state,
    };
  if (
    event.operation !== "expire" &&
    (state === "expired" ||
      (event.at >= deadline && !terminals.includes(state)))
  )
    return { state, error: "EXPIRED" };
  const target = targets[event.operation];
  if (!graph[state].some((allowed) => allowed === target))
    return { state, error: "INVALID_TRANSITION" };
  return { state: target };
}

function invoke(
  session: DeviceAuthorizationSession,
  event: Event,
): DeviceAuthorizationSession {
  const now = new Date(event.at);
  switch (event.operation) {
    case "approve":
      return approveDeviceAuth(session, event.actor, now);
    case "deny":
      return denyDeviceAuth(session, now);
    case "consume":
      return consumeDeviceAuth(session, now);
    case "expire":
      return expireDeviceAuth(session, now);
    case "maybe":
      return maybeExpireDeviceAuth(session, () => now);
    case "poll":
      return recordDevicePoll(session, now);
  }
}

function initial(): DeviceAuthorizationSession {
  return {
    id: "device",
    clientId: "client",
    deviceCodeDigest: new Uint8Array([1]),
    userCodeDigest: new Uint8Array([2]),
    requestedScopes: ["openid"],
    requestedResources: [],
    state: "pending",
    intervalSeconds: 5,
    createdAt: new Date(1_000),
    expiresAt: new Date(deadline),
    pollCount: 0,
  };
}

type Coverage = {
  approved: number;
  denied: number;
  consumed: number;
  expired: number;
  late: number;
  terminalPoll: number;
};

function applyEvent(
  session: DeviceAuthorizationSession,
  event: Event,
  coverage: Coverage,
) {
  const before = structuredClone(session);
  const expected = predict(session.state, event);
  let outcome: DeviceAuthorizationSession | undefined;
  let failure: unknown;
  try {
    outcome = invoke(session, event);
  } catch (error) {
    failure = error;
  }
  expect(session).toEqual(before);
  if (expected.error) {
    expect(failure).toBeInstanceOf(DomainError);
    if (!(failure instanceof DomainError))
      throw new Error("Expected a domain error");
    expect(failure.code).toBe(expected.error);
    if (expected.error === "EXPIRED") coverage.late++;
    return session;
  }
  expect(failure).toBeUndefined();
  if (!outcome) throw new Error("Expected a device authorization result");
  expect(outcome.state).toBe(expected.state);
  expect(outcome.id).toBe(before.id);
  expect(outcome.deviceCodeDigest).toEqual(before.deviceCodeDigest);
  expect(outcome.userCodeDigest).toEqual(before.userCodeDigest);
  expect(outcome.pollCount).toBe(
    before.pollCount + (event.operation === "poll" ? 1 : 0),
  );
  if (event.operation === "approve" && outcome.state === "approved")
    expect(outcome.approvedByPrincipalId).toBe(event.actor);
  if (outcome.state !== before.state && outcome.state !== "pending")
    coverage[outcome.state]++;
  if (event.operation === "poll" && terminals.includes(before.state))
    coverage.terminalPoll++;
  return outcome;
}

it("preserves device authorization invariants over generated operation sequences", () => {
  const coverage: Coverage = {
    approved: 0,
    denied: 0,
    consumed: 0,
    expired: 0,
    late: 0,
    terminalPoll: 0,
  };
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          operation: fc.constantFrom(
            "approve",
            "deny",
            "consume",
            "expire",
            "maybe",
            "poll",
          ),
          at: fc.constantFrom(3_999, 4_000, 4_001),
          actor: fc.constantFrom("alice", "bob"),
        }),
        { minLength: 1, maxLength: 30 },
      ),
      (events) => {
        let session = initial();
        for (const event of events)
          session = applyEvent(session, event, coverage);
      },
    ),
    { seed: 20261117, numRuns: 400 },
  );
  for (const [name, count] of Object.entries(coverage))
    expect(count, `generated cases must exercise ${name}`).toBeGreaterThan(0);
});
