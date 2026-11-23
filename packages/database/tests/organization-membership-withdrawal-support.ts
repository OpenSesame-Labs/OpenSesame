import { randomUUID } from "node:crypto";
import type {
  Organization,
  OrganizationMembership,
} from "@opensesame/os-domain";
import type {
  OrganizationMembershipStore,
  OrganizationMembershipWithdrawal,
} from "../src/repos/interfaces.js";
import {
  MemoryRepositories,
  createMemoryOrganizationStores,
} from "../src/repos/memory.js";
import { createPostgresOrganizationStores } from "../src/repos/postgres.js";
import { makePrincipal } from "./factories.js";
import type { PgTestContext } from "./pg-harness-full.js";

/** What {@link fixture} hands a withdrawal test: the store and the seeded row. */
export type MembershipFixture = {
  store: OrganizationMembershipStore;
  row: OrganizationMembership;
};

export async function fixture(
  pg: PgTestContext,
  sql: boolean,
): Promise<MembershipFixture> {
  const repos = sql ? pg.repos : new MemoryRepositories();
  const stores = sql
    ? createPostgresOrganizationStores(pg.db)
    : createMemoryOrganizationStores();
  const principal = await repos.principals.create(makePrincipal());
  const now = new Date("2026-08-24T09:00:00.000Z");
  const org: Organization = {
    id: `org_${randomUUID()}`,
    slug: `org-${randomUUID()}`,
    displayName: "Example",
    state: "active",
    createdBy: principal.id,
    createdAt: now,
    updatedAt: now,
  };
  await stores.organizations.set(org.id, org);
  const row: OrganizationMembership = {
    organizationId: org.id,
    principalId: principal.id,
    role: "member",
    createdAt: now,
    updatedAt: now,
  };
  await stores.organizationMemberships.upsert(row);
  return { store: stores.organizationMemberships, row };
}

export function removal(id: string): OrganizationMembershipWithdrawal {
  return {
    id,
    kind: "remove",
    reason: "organization_owner_removed",
    actorType: "human",
    actorPrincipalId: "actor",
    correlationId: "request-1",
  };
}
