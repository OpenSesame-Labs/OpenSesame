import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Interaction } from "../../../packages/os-domain/src/interaction.js";
import {
  approve,
  consume,
} from "../../../packages/os-domain/src/machines/interaction.js";
import { sealApprovalProof } from "../../../packages/os-domain/src/proofs/approval-seal.js";

const kinds = [
  "device_authorization",
  "pairing",
  "claim",
  "grant_claim",
  "authorization_request",
  "transaction_authorization",
] as const;
const statuses = [
  "pending",
  "presented",
  "awaiting_approval",
  "approved",
  "denied",
  "consumed",
  "expired",
  "revoked",
] as const;
const clocks = ["invalid", "valid"] as const;
const expiries = ["invalid", "past", "equal", "future"] as const;
const requestDigests = ["absent", "empty", "a", "b"] as const;
const proofDigests = ["empty", "a", "b", "other"] as const;

function choice<const T extends readonly string[]>(
  choices: T,
  value: string,
): T[number] {
  const selected = choices.find((candidate) => candidate === value);
  if (selected === undefined)
    throw new Error(`Unknown formal vector value: ${value}`);
  return selected;
}

function combinations(dimensions: readonly (readonly string[])[]): string[] {
  let prefixes = [""];
  for (const options of dimensions) {
    const next: string[] = [];
    for (const prefix of prefixes) {
      for (const option of options) {
        next.push(prefix ? `${prefix}/${option}` : option);
      }
    }
    prefixes = next;
  }
  return prefixes;
}

const path = process.env.OPENSESAME_APPROVAL_VECTORS;
if (!path)
  throw new Error(
    "Run spec/formal/webauthn/verify.sh to generate Lean vectors",
  );
const vectors = readFileSync(path, "utf8")
  .trim()
  .split("\n")
  .map((line) => line.split("\t"));
const now = new Date(0);

describe("Lean approval binding correspondence", () => {
  it("refuses an operation whose present request digest and proof digest are empty", () => {
    const interaction: Interaction = {
      id: "int_empty_digest",
      kind: "transaction_authorization",
      status: "awaiting_approval",
      subject: {
        kind: "transaction_authorization",
        subjectId: "subject_empty_digest",
      },
      createdAt: now,
      expiresAt: new Date(1),
      authorizationDetails: [],
      requestDigest: "",
      version: 1,
    };
    const proof = sealApprovalProof({
      mechanism: "webauthn",
      assurance: "phishing_resistant",
      boundDigest: "",
      verifiedAt: now,
    });
    expect(() =>
      approve(interaction, { approverPrincipalId: "prn_formal", proof, now }),
    ).toThrow(/digest/);
  });

  it("retains digest-free approval for session-only interaction kinds", () => {
    const proof = sealApprovalProof({
      mechanism: "session_reauth",
      assurance: "verified",
      boundDigest: "",
      verifiedAt: now,
    });
    for (const kind of ["device_authorization", "pairing", "claim"] as const) {
      for (const requestDigest of [undefined, ""] as const) {
        const interaction: Interaction = {
          id: "int_session",
          kind,
          status: "awaiting_approval",
          subject: { kind, subjectId: "subject_session" },
          createdAt: now,
          expiresAt: new Date(1),
          authorizationDetails: [],
          version: 1,
        };
        if (requestDigest !== undefined)
          interaction.requestDigest = requestDigest;
        const result = approve(interaction, {
          approverPrincipalId: "prn_formal",
          proof,
          now,
        });
        expect(result.status).toBe("approved");
      }
    }
  });

  it("contains every declared abstract case exactly once", () => {
    const expected = new Set(
      combinations([
        kinds,
        statuses,
        clocks,
        expiries,
        requestDigests,
        proofDigests,
      ]),
    );
    expect(vectors).toHaveLength(expected.size);
    expect(new Set(vectors.map((row) => row.slice(1, 7).join("/")))).toEqual(
      expected,
    );
    expect(
      vectors.every(
        (row) =>
          row.length === 8 &&
          row[0] === "approval" &&
          ["0", "1"].includes(row[7]),
      ),
    ).toBe(true);
  });

  it.each(vectors)("approval %s %s %s %s %s %s %s", (...row) => {
    const [
      _type,
      kindInput,
      statusInput,
      clockInput,
      expiryInput,
      requestInput,
      proofInput,
      expected,
    ] = row;
    const kind = choice(kinds, kindInput);
    const status = choice(statuses, statusInput);
    const clock = choice(clocks, clockInput);
    const sampledNow = clock === "valid" ? now : new Date(Number.NaN);
    const expiry = choice(expiries, expiryInput);
    const request = choice(requestDigests, requestInput);
    const proofValue = choice(proofDigests, proofInput);
    const digest = {
      absent: undefined,
      empty: "",
      a: "sha256:a",
      b: "sha256:b",
    }[request];
    const expiresAt = {
      invalid: new Date(Number.NaN),
      past: new Date(-1),
      equal: new Date(0),
      future: new Date(1),
    }[expiry];
    const interaction: Interaction = {
      id: "int_formal",
      kind,
      status,
      subject: { kind, subjectId: "subject_formal" },
      createdAt: now,
      expiresAt,
      authorizationDetails: [],
      version: 1,
    };
    if (digest !== undefined) interaction.requestDigest = digest;
    const boundDigest = {
      empty: "",
      a: "sha256:a",
      b: "sha256:b",
      other: "sha256:other",
    }[proofValue];
    const proof = sealApprovalProof({
      mechanism: "webauthn",
      assurance: "phishing_resistant",
      boundDigest,
      verifiedAt: now,
    });
    const key = [
      kindInput,
      statusInput,
      clockInput,
      expiryInput,
      requestInput,
      proofInput,
    ].join("/");
    let result: Interaction | undefined;
    try {
      result = approve(interaction, {
        approverPrincipalId: "prn_formal",
        proof,
        now: sampledNow,
      });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "DomainError")
        throw error;
    }
    expect(result !== undefined, key).toBe(expected === "1");
    if (result) {
      expect(result.status, key).toBe("approved");
      expect(result.approvalProof?.boundDigest, key).toBe(boundDigest);
      expect(result.version, key).toBe(interaction.version + 1);
      const consumed = consume(result, sampledNow);
      expect(consumed.status, key).toBe("consumed");
      expect(() => consume(consumed, sampledNow), key).toThrow();
    }
  });
});
