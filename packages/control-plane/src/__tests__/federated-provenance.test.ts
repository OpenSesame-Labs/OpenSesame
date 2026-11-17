import { describe, expect, it } from "vitest";
import { pendingMatchesTrust } from "../interactions/federated-provenance.js";
import type { TrustResolution } from "../interactions/trust.js";

const PENDING = {
  issuer: "https://shoo.dev",
  state: "st",
  nonce: "no",
  verifier: "ve",
};

const STATIC_TRUST = {
  source: "static",
  provider: {
    id: "shoo",
    kind: "oidc",
    label: "Shoo",
    issuer: PENDING.issuer,
    scopes: "openid",
    clientAuth: "none",
  },
} as const satisfies TrustResolution;

const BYO_TRUST = {
  source: "byo",
  record: {
    id: "byo_1",
    issuer: PENDING.issuer,
    label: "Personal provider",
    clientId: "client",
    clientAuth: "none",
    registrationSource: "manual",
    state: "active",
    createdAt: new Date(),
  },
} as const satisfies TrustResolution;

const ORG_TRUST = {
  source: "org",
  organizationId: "org_1",
  issuer: PENDING.issuer,
  method: "sso",
} as const satisfies TrustResolution;

describe("pending provenance matches resolved trust", () => {
  it("accepts each legitimate source and a safe legacy OIDC leg", () => {
    expect(pendingMatchesTrust(PENDING, STATIC_TRUST)).toBe(true);
    expect(
      pendingMatchesTrust({ ...PENDING, kind: "oidc" }, STATIC_TRUST),
    ).toBe(true);
    expect(
      pendingMatchesTrust(
        { ...PENDING, kind: "oidc", providerId: "shoo" },
        STATIC_TRUST,
      ),
    ).toBe(true);
    expect(
      pendingMatchesTrust(
        { ...PENDING, kind: "oidc", byoId: "byo_1" },
        BYO_TRUST,
      ),
    ).toBe(true);
    expect(
      pendingMatchesTrust(
        { ...PENDING, kind: "oidc", orgId: "org_1" },
        ORG_TRUST,
      ),
    ).toBe(true);
  });

  it("rejects tenant, source, and issuer substitutions", () => {
    expect(pendingMatchesTrust(PENDING, ORG_TRUST)).toBe(false);
    expect(
      pendingMatchesTrust(
        { ...PENDING, kind: "oidc", orgId: "org_target" },
        ORG_TRUST,
      ),
    ).toBe(false);
    expect(
      pendingMatchesTrust(
        { ...PENDING, kind: "oidc", orgId: "org_1" },
        STATIC_TRUST,
      ),
    ).toBe(false);
    expect(
      pendingMatchesTrust(
        {
          ...PENDING,
          issuer: "https://other.example",
          kind: "oidc",
          orgId: "org_1",
        },
        ORG_TRUST,
      ),
    ).toBe(false);
    expect(
      pendingMatchesTrust(
        {
          ...PENDING,
          kind: "oidc",
          providerId: "shoo",
          orgId: "org_1",
        },
        STATIC_TRUST,
      ),
    ).toBe(false);
  });
});
