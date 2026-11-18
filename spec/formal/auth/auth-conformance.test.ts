import { readFileSync } from "node:fs";
import { name } from "@gdp-ts/core";
import { describe, expect, it } from "vitest";
import {
  actorId,
  projectId,
} from "../../../packages/control-plane/src/lib/ids.js";
import { resolveProvisionalSession } from "../../../packages/control-plane/src/middleware/auth.js";
import { projectAccess } from "../../../packages/control-plane/src/proofs/project-role.js";
import { verifiedPrincipal } from "../../../packages/control-plane/src/proofs/verified-principal.js";
import { overlapCast } from "../../../packages/os-domain/src/json.js";

const assuranceCases = [
  "missing",
  "provisional",
  "self_asserted",
  "verified",
  "mfa",
  "phishing_resistant",
  "enterprise_managed",
  "workload_attested",
] as const;
const states = [
  "provisional",
  "active",
  "expired",
  "deleting",
  "deleted",
] as const;
const expiries = ["none", "past", "equal", "future"] as const;
const roles = ["none", "member", "admin", "owner"] as const;
const sessionExpiries = ["past", "equal", "future"] as const;
const sessionPrincipals = [
  "missing",
  "provisional",
  "active",
  "suspended",
  "closed",
] as const;

function choice<const T extends readonly string[]>(
  choices: T,
  value: string | undefined,
): T[number] {
  const found = choices.find((item) => item === value);
  if (found === undefined)
    throw new Error(`Unknown formal vector value: ${value}`);
  return found;
}

function productKeys(axes: readonly (readonly string[])[]): Set<string> {
  let rows: string[][] = [[]];
  for (const axis of axes) {
    rows = rows.flatMap((row) => axis.map((value) => [...row, value]));
  }
  return new Set(rows.map((row) => row.join("/")));
}

const path = process.env.OPENSESAME_AUTH_FORMAL_VECTORS;
if (!path)
  throw new Error(
    "Run scripts/test/auth-formal.sh to generate Lean vectors first",
  );
const vectors = readFileSync(path, "utf8")
  .trim()
  .split("\n")
  .map((line) => line.split("\t"));
const principals = vectors.filter(([kind]) => kind === "principal");
const sessions = vectors.filter(([kind]) => kind === "session");
const projects = vectors.filter(([kind]) => kind === "project");
const now = new Date(0);

describe("Lean auth policy correspondence", () => {
  it("contains every declared abstract case exactly once", () => {
    expect(principals).toHaveLength(assuranceCases.length);
    expect(new Set(principals.map((row) => row[1]))).toEqual(
      new Set(assuranceCases),
    );
    const bits = ["0", "1"] as const;
    const expectedSessions = productKeys([
      bits,
      bits,
      bits,
      sessionExpiries,
      bits,
      sessionPrincipals,
    ]);
    expect(sessions).toHaveLength(expectedSessions.size);
    expect(new Set(sessions.map((row) => row.slice(1, 7).join("/")))).toEqual(
      expectedSessions,
    );
    const expected = productKeys([bits, states, expiries, roles]);
    expect(projects).toHaveLength(expected.size);
    expect(new Set(projects.map((row) => row.slice(1, 5).join("/")))).toEqual(
      expected,
    );
    expect(vectors).toHaveLength(
      principals.length + sessions.length + projects.length,
    );
  });

  it.each(sessions.map((row) => ({ row })))("session $row", async ({ row }) => {
    const [
      ,
      prefix,
      mapped,
      present,
      expiryValue,
      unrevoked,
      principalValue,
      expected,
    ] = row;
    const expiry = choice(sessionExpiries, expiryValue);
    const principalState = choice(sessionPrincipals, principalValue);
    const session = {
      id: "ps_formal",
      principalId: "prn_formal",
      expiresAt: {
        past: new Date(-1),
        equal: new Date(0),
        future: new Date(1),
      }[expiry],
      revokedAt: unrevoked === "1" ? undefined : new Date(-1),
    };
    // This fixture supplies the stores, repository, and clock read by the resolver;
    // unrelated AppContext services are intentionally absent.
    const ctx: Parameters<typeof resolveProvisionalSession>[0] = overlapCast({
      stores: {
        provisionalTokens: {
          get: async () => (mapped === "1" ? "ps_formal" : undefined),
        },
        provisionalSessions: {
          get: async () => (present === "1" ? session : undefined),
        },
      },
      repos: {
        principals: {
          getById: async () =>
            principalState === "missing"
              ? undefined
              : { state: principalState },
        },
      },
      clock: () => now,
    });
    const result = await resolveProvisionalSession(
      ctx,
      prefix === "1" ? "pst_formal" : "ps_formal",
    );
    if (expected === "1") {
      expect(result).toEqual({
        principalId: "prn_formal",
        sessionId: "ps_formal",
      });
    } else {
      expect(result).toBeUndefined();
    }
  });

  it.each(principals)("principal %s %s", async (_kind, input, expected) => {
    const assurance = choice(assuranceCases, input);
    const principal =
      assurance === "missing"
        ? undefined
        : {
            id: "prn_formal",
            state: "active" as const,
            assurance,
            createdAt: now,
            updatedAt: now,
            version: 1,
          };
    // The prover reads only principals.getById; other repository operations are unused.
    const repos: Parameters<typeof verifiedPrincipal>[0] = overlapCast({
      principals: { getById: async () => principal },
    });
    const verdict = await name(actorId("prn_formal"), (actor) =>
      verifiedPrincipal(repos, actor),
    );
    expect(verdict.ok ? "admitted" : verdict.reason).toBe(expected);
    if (verdict.ok) expect(verdict.proof.kind).toBe("VerifiedPrincipal");
  });

  it.each(projects.map((row) => ({ row })))("project $row", async ({ row }) => {
    const [
      ,
      present,
      stateValue,
      expiryValue,
      roleValue,
      expectedRole,
      expectedMember,
      expectedAdmin,
      expectedOwner,
    ] = row;
    const state = choice(states, stateValue);
    const expiry = choice(expiries, expiryValue);
    const role = choice(roles, roleValue);
    const expiryDate = {
      none: undefined,
      past: new Date(-1),
      equal: new Date(0),
      future: new Date(1),
    }[expiry];
    const project = {
      id: "prj_formal",
      kind: "standard" as const,
      state,
      expiresAt: expiryDate,
      slug: "formal",
      displayName: "Formal",
      createdAt: now,
      updatedAt: now,
    };
    // projectAccess and roleFor read only these two stores and the clock.
    const ctx: Parameters<typeof projectAccess>[0] = overlapCast({
      stores: {
        projects: {
          get: async () => (present === "1" ? project : undefined),
        },
        projectMemberships: {
          find: async () => (role === "none" ? undefined : { role }),
        },
      },
      clock: () => now,
    });
    const verdict = await name(
      actorId("prn_formal"),
      projectId("prj_formal"),
      (actor, namedProject) => projectAccess(ctx, actor, namedProject),
    );
    if (!verdict.ok) {
      expect(verdict).toEqual({ ok: false, status: 404, error: "not_found" });
      expect([
        expectedRole,
        expectedMember,
        expectedAdmin,
        expectedOwner,
      ]).toEqual(["denied", "0", "0", "0"]);
      return;
    }
    expect([
      verdict.role,
      "1",
      "admin" in verdict ? "1" : "0",
      "owner" in verdict ? "1" : "0",
    ]).toEqual([expectedRole, expectedMember, expectedAdmin, expectedOwner]);
    expect(verdict.member.kind).toBe("ProjectMember");
    if ("admin" in verdict) expect(verdict.admin.kind).toBe("ProjectAdmin");
    if ("owner" in verdict) expect(verdict.owner.kind).toBe("ProjectOwner");
  });
});
