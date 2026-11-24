import { fixtures } from "@opensesame/os-domain";
import { assertAtMostWins } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import {
  AGENT_AUTH_SCOPES,
  AGENT_AUTH_SCOPE_ACTIONS,
  AGENT_AUTH_SCOPE_DESCRIPTIONS,
  DEFAULT_POST_CLAIM_SCOPES,
  DEFAULT_PRE_CLAIM_SCOPES,
  evaluateAgentAuthScopes,
  intersectAgentAuthScopes,
  isAgentAuthScope,
  parseScopeParameter,
  scopesForRegistrationState,
} from "../agent-auth-scopes.js";
import { ProvisionalPolicy } from "../provisional.js";

describe("agent-auth scope intersection", () => {
  it("never unions requested scopes with registration scopes", () => {
    expect(
      intersectAgentAuthScopes({
        requested: ["resource:read", "claim:create"],
        registration: ["resource:read"],
      }),
    ).toEqual(["resource:read"]);
  });

  it("intersects resource-supported scopes", () => {
    expect(
      intersectAgentAuthScopes({
        requested: ["resource:read", "resource:create:temporary"],
        registration: ["resource:read", "resource:create:temporary"],
        resourceSupported: ["resource:read"],
      }),
    ).toEqual(["resource:read"]);
  });

  it("uses registration scopes when none are requested", () => {
    expect(DEFAULT_PRE_CLAIM_SCOPES).toEqual([
      "resource:read",
      "resource:create:temporary",
    ]);
    expect(DEFAULT_POST_CLAIM_SCOPES).toEqual([
      "resource:read",
      "resource:create:temporary",
      "project:create:temporary",
      "claim:create",
    ]);
    expect(
      intersectAgentAuthScopes({
        registration: [...DEFAULT_PRE_CLAIM_SCOPES],
      }),
    ).toEqual(["resource:read", "resource:create:temporary"]);
  });

  it("parses space and plus separated scope parameters", () => {
    expect(parseScopeParameter(undefined)).toBeUndefined();
    expect(parseScopeParameter("")).toBeUndefined();
    expect(parseScopeParameter("  ")).toBeUndefined();
    expect(parseScopeParameter("resource:read claim:create")).toEqual([
      "resource:read",
      "claim:create",
    ]);
    expect(parseScopeParameter("resource:read+claim:create")).toEqual([
      "resource:read",
      "claim:create",
    ]);
    expect(parseScopeParameter("resource:read++claim:create")).toEqual([
      "resource:read",
      "claim:create",
    ]);
    expect(isAgentAuthScope("resource:read")).toBe(true);
    expect(isAgentAuthScope("admin.impersonate")).toBe(false);
  });

  it("maps every protocol scope onto a domain action and a description", () => {
    expect(AGENT_AUTH_SCOPE_ACTIONS).toEqual({
      "resource:read": "resource.read",
      "resource:create:temporary": "resource.create_temporary",
      "project:create:temporary": "project.create_temporary",
      "claim:create": "claim.create",
    });
    expect(AGENT_AUTH_SCOPE_DESCRIPTIONS).toEqual({
      "resource:read": "Read resources the registration is allowed to see",
      "resource:create:temporary": "Create TTL-bound temporary resources",
      "project:create:temporary": "Create a TTL-bound temporary project",
      "claim:create": "Create a claim session for later human confirmation",
    });
    for (const scope of AGENT_AUTH_SCOPES) {
      expect(AGENT_AUTH_SCOPE_ACTIONS[scope]).not.toContain(":");
    }
  });
});

describe("registration-state scope profiles", () => {
  it("keeps pre-claim scopes until claimed", () => {
    expect(
      scopesForRegistrationState({
        claimed: false,
        preClaimScopes: DEFAULT_PRE_CLAIM_SCOPES,
        postClaimScopes: DEFAULT_POST_CLAIM_SCOPES,
      }),
    ).toEqual([...DEFAULT_PRE_CLAIM_SCOPES]);
  });

  it("does not leave pre-claim tokens able to pick up post-claim scopes", () => {
    const pre = scopesForRegistrationState({
      claimed: false,
      preClaimScopes: DEFAULT_PRE_CLAIM_SCOPES,
      postClaimScopes: DEFAULT_POST_CLAIM_SCOPES,
    });
    expect(pre).not.toContain("claim:create");
    expect(pre).not.toEqual([...DEFAULT_POST_CLAIM_SCOPES]);
  });
});

describe("policy evaluation of protocol scopes", () => {
  const policy = new ProvisionalPolicy();

  it("allows provisional principals the pre-claim profile", () => {
    const result = evaluateAgentAuthScopes(
      policy,
      fixtures.provisionalPrincipal(),
      DEFAULT_PRE_CLAIM_SCOPES,
    );
    expect(result.denied).toEqual([]);
    expect(result.allowed).toEqual([...DEFAULT_PRE_CLAIM_SCOPES]);
  });

  it("does not let a protocol scope bypass high-risk policy", () => {
    const result = evaluateAgentAuthScopes(
      policy,
      fixtures.verifiedPrincipal(),
      ["principal.merge"],
    );
    expect(result.allowed).toEqual([]);
    expect(result.denied).toEqual(["principal.merge"]);
    expect(result.decisions).toEqual([
      { effect: "deny", reasons: ["unknown_scope", "principal.merge"] },
    ]);
  });

  it("dedupes a requested scope listed twice", () => {
    expect(
      intersectAgentAuthScopes({
        requested: ["resource:read", "resource:read"],
        registration: ["resource:read"],
      }),
    ).toEqual(["resource:read"]);
  });
});

describe("PACT — agent-auth scopes", () => {
  it("property: intersection is never a union", () => {
    const left = intersectAgentAuthScopes({
      requested: ["resource:read", "claim:create"],
      registration: ["resource:read"],
    });
    const right = intersectAgentAuthScopes({
      requested: ["resource:read"],
      registration: ["resource:read", "claim:create"],
    });
    expect(left).toEqual(["resource:read"]);
    expect(right).toEqual(["resource:read"]);
    expect(new Set([...left, ...right]).size).toBe(1);
  });

  it("adversarial: an unknown protocol name cannot buy a domain action", () => {
    const policy = new ProvisionalPolicy();
    const result = evaluateAgentAuthScopes(
      policy,
      fixtures.verifiedPrincipal(),
      ["principal.merge", "grant.export_raw_credential"],
    );
    expect(result.allowed).toEqual([]);
    expect(result.denied).toEqual([
      "principal.merge",
      "grant.export_raw_credential",
    ]);
  });

  it("contract: post-claim is a strict superset of pre-claim", () => {
    for (const scope of DEFAULT_PRE_CLAIM_SCOPES) {
      expect(DEFAULT_POST_CLAIM_SCOPES).toContain(scope);
    }
    expect(DEFAULT_POST_CLAIM_SCOPES.length).toBeGreaterThan(
      DEFAULT_PRE_CLAIM_SCOPES.length,
    );
  });

  it("chaos: concurrent evaluators at the unknown-scope input fail closed", async () => {
    const policy = new ProvisionalPolicy();
    await assertAtMostWins(async () => {
      return (
        evaluateAgentAuthScopes(policy, fixtures.provisionalPrincipal(), [
          "admin.impersonate",
        ]).allowed.length > 0
      );
    }, 0);
  });
});
