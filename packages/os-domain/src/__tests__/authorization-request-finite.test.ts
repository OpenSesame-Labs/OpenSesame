import { describe, expect, it } from "vitest";
import { DomainError, type DomainErrorCode } from "../errors.js";
import {
  canTransition,
  maybeExpire,
  settle,
  withdrawRequest,
} from "../machines/authorization-request.js";
import type {
  ApprovalDecidedByKind,
  AuthorizationRequest,
  AuthorizationRequestStatus,
  PrincipalId,
} from "../types.js";

const STATUSES: AuthorizationRequestStatus[] = [
  "pending",
  "approved",
  "denied",
  "cancelled",
  "expired",
];
const DECISIONS: ("approved" | "denied" | "cancelled")[] = [
  "approved",
  "denied",
  "cancelled",
];
const ACTORS: PrincipalId[] = ["alice", "bob"];
const KINDS: ApprovalDecidedByKind[] = ["human", "agent"];
const BEFORE = new Date(3_999);
const AT_DEADLINE = new Date(4_000);
const TIMES = [BEFORE, AT_DEADLINE, new Date(4_001)];
const DECISION_INPUTS = DECISIONS.flatMap((status) =>
  KINDS.flatMap((decidedByKind) =>
    ACTORS.map((decidedByPrincipalId) => ({
      status,
      decidedByKind,
      decidedByPrincipalId,
    })),
  ),
);
const REQUEST_INPUTS = [1, 17].flatMap((version) =>
  ["digest-a", "digest-b"].flatMap((digest) =>
    ACTORS.map((principal) => ({ version, digest, principal })),
  ),
);

function pending(
  version: number,
  requestDigest: string,
  principalId: PrincipalId,
): AuthorizationRequest {
  return {
    id: "request-id",
    principalId,
    requesterRef: "requester-ref",
    authorizationDetails: [
      { type: "connection_delegation", actions: ["read"] },
    ],
    requestDigest,
    bindingMessage: "Read an item",
    status: "pending",
    intervalSeconds: 5,
    connectionId: "connection-id",
    delegationId: "delegation-id",
    createdAt: new Date(1_000),
    expiresAt: new Date(4_000),
    version,
  };
}

function sources(initial: AuthorizationRequest): AuthorizationRequest[] {
  return [
    initial,
    ...DECISION_INPUTS.map((input) =>
      settle(initial, { ...input, now: BEFORE }),
    ),
    withdrawRequest(initial, BEFORE),
    maybeExpire(initial, AT_DEADLINE),
  ];
}

function rejection(act: () => AuthorizationRequest, code: DomainErrorCode) {
  let seen: DomainError | undefined;
  try {
    act();
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    seen = error;
  }
  expect(seen?.code).toBe(code);
}

function decisionCase(
  request: AuthorizationRequest,
  now: Date,
  status: (typeof DECISIONS)[number],
  decidedByKind: ApprovalDecidedByKind,
  decidedByPrincipalId: PrincipalId,
) {
  const before = structuredClone(request);
  const invoke = () =>
    settle(request, { status, decidedByKind, decidedByPrincipalId, now });
  if (request.status !== "pending") {
    rejection(invoke, "INVALID_TRANSITION");
  } else if (now.getTime() >= request.expiresAt.getTime()) {
    rejection(invoke, "EXPIRED");
  } else {
    expect(invoke()).toEqual({
      ...before,
      status,
      decidedByKind,
      decidedByPrincipalId,
      decidedAt: now,
      version: before.version + 1,
    });
  }
  expect(request).toEqual(before);
}

function withdrawalCase(request: AuthorizationRequest, now: Date) {
  const before = structuredClone(request);
  const invoke = () => withdrawRequest(request, now);
  if (request.status !== "pending") {
    rejection(invoke, "INVALID_TRANSITION");
  } else if (now.getTime() >= request.expiresAt.getTime()) {
    rejection(invoke, "EXPIRED");
  } else {
    const result = invoke();
    expect(result).toEqual({
      ...before,
      status: "cancelled",
      decidedAt: now,
      version: before.version + 1,
    });
    expect(result.decidedByPrincipalId).toBeUndefined();
    expect(result.decidedByKind).toBeUndefined();
  }
  expect(request).toEqual(before);
}

function expiryCase(request: AuthorizationRequest, now: Date) {
  const before = structuredClone(request);
  const result = maybeExpire(request, now);
  if (
    request.status === "pending" &&
    now.getTime() >= request.expiresAt.getTime()
  ) {
    expect(result).toEqual({
      ...before,
      status: "expired",
      version: before.version + 1,
    });
    expect(result.decidedAt).toBeUndefined();
    expect(result.decidedByPrincipalId).toBeUndefined();
    expect(result.decidedByKind).toBeUndefined();
  } else {
    expect(result).toBe(request);
  }
  expect(request).toEqual(before);
}

function exerciseRequest(request: AuthorizationRequest) {
  for (const now of TIMES) {
    expiryCase(request, now);
    withdrawalCase(request, now);
    for (const input of DECISION_INPUTS) {
      decisionCase(
        request,
        now,
        input.status,
        input.decidedByKind,
        input.decidedByPrincipalId,
      );
    }
  }
}

describe("authorization request finite behavior", () => {
  it("admits exactly the pending-to-terminal transition edges", () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        expect(canTransition(from, to)).toBe(
          from === "pending" && to !== "pending",
        );
      }
    }
  });

  it("preserves bindings and terminal outcomes over each reachable state and deadline boundary", () => {
    for (const { version, digest, principal } of REQUEST_INPUTS) {
      for (const request of sources(pending(version, digest, principal))) {
        exerciseRequest(request);
      }
    }
  });
});
