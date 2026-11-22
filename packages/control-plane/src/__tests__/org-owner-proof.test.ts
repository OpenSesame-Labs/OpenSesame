import { name } from "@gdp-ts/core";
import type {
  OrganizationRole,
  OrganizationState,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { actorId, organizationId } from "../lib/ids.js";
import {
  type OrgLiveness,
  activeOrgOwner,
  orgOwner,
} from "../proofs/org-owner.js";
import { createAppStores } from "../state.js";

const NOW = new Date("2026-01-01T00:00:00Z");

async function ownerStores(
  state: OrganizationState,
  role: OrganizationRole | undefined,
) {
  const stores = createAppStores();
  await stores.organizations.set("org:a", {
    id: "org:a",
    slug: "a",
    displayName: "A",
    state,
    createdBy: "prn_creator",
    createdAt: NOW,
    updatedAt: NOW,
  });
  if (role) {
    await stores.organizationMemberships.upsert({
      organizationId: "org:a",
      principalId: "prn_1",
      role,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  return stores;
}

async function verdictFor(
  state: OrganizationState,
  role: OrganizationRole | undefined,
  liveness: OrgLiveness,
) {
  const stores = await ownerStores(state, role);
  return name(actorId("prn_1"), organizationId("org:a"), (actor, org) =>
    orgOwner(stores, actor, org, liveness),
  );
}

/**
 * Recovery surfaces can reach a non-deleted organization; membership and
 * provisioning administration require it to be active (ADR 0178).
 */
const MATRIX: ReadonlyArray<[OrganizationState, Record<OrgLiveness, boolean>]> =
  [
    ["active", { not_deleted: true, active: true }],
    ["provisional", { not_deleted: true, active: false }],
    ["suspended", { not_deleted: true, active: false }],
    ["deleted", { not_deleted: false, active: false }],
  ];

describe("orgOwner proof", () => {
  for (const [state, expected] of MATRIX) {
    it(`checks ${state} organizations when minting active-owner proof`, async () => {
      const stores = await ownerStores(state, "owner");
      const verdict = await name(
        actorId("prn_1"),
        organizationId("org:a"),
        (actor, org) => activeOrgOwner(stores, actor, org),
      );
      expect(verdict.ok).toBe(expected.active);
      if (verdict.ok) expect(verdict.proof.kind).toBe("ActiveOrgOwner");
    });
    for (const liveness of ["not_deleted", "active"] as const) {
      it(`an owner of a ${state} organization is ${
        expected[liveness] ? "proven" : "refused 404"
      } under '${liveness}'`, async () => {
        const verdict = await verdictFor(state, "owner", liveness);
        if (expected[liveness]) {
          expect(verdict.ok).toBe(true);
          if (verdict.ok) expect(verdict.proof.kind).toBe("OrgOwner");
        } else {
          expect(verdict).toEqual({
            ok: false,
            status: 404,
            error: "not_found",
          });
        }
      });
    }
  }

  it("answers 403 owner_required for a member who is not an owner", async () => {
    for (const role of ["admin", "member"] as const) {
      expect(await verdictFor("active", role, "not_deleted")).toEqual({
        ok: false,
        status: 403,
        error: "owner_required",
      });
    }
  });

  it("answers 404, never 403, for someone with no membership", async () => {
    expect(await verdictFor("active", undefined, "not_deleted")).toEqual({
      ok: false,
      status: 404,
      error: "not_found",
    });
  });

  it("answers 404 for an organization that does not exist", async () => {
    const stores = createAppStores();
    const verdict = await name(
      actorId("prn_1"),
      organizationId("org:missing"),
      (actor, org) => orgOwner(stores, actor, org, "active"),
    );
    expect(verdict).toEqual({ ok: false, status: 404, error: "not_found" });
  });
});
