import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { createPostgresOrganizationStores } from "../src/repos/postgres.js";
import {
  scimGroupRoleMappings,
  scimGroups,
} from "../src/schema/scim-groups.js";
import {
  SCIM_GROUP_ID_MAX,
  ScimGroupPayloadError,
  scimMappingAdmissible,
} from "../src/scim-group-limits.js";
import {
  type ScimStores,
  createMemoryScimStores,
  createPostgresScimStores,
} from "../src/scim-group-store.js";
import { makePrincipal } from "./factories.js";
import { createPgOwner } from "./pg-harness-full.js";

const owner = createPgOwner();
afterAll(() => owner.close());

const LEGACY = `legacy-${"g".repeat(SCIM_GROUP_ID_MAX)}`;
const LEGACY_MEMBER = `member-${"m".repeat(SCIM_GROUP_ID_MAX)}`;
const FRESH = `fresh-${"f".repeat(SCIM_GROUP_ID_MAX)}`;

function group(orgId: string, id: string, memberIds: string[]) {
  const now = new Date();
  return {
    id,
    organizationId: orgId,
    displayName: id,
    memberIds,
    createdAt: now,
    updatedAt: now,
  };
}

/** New over-long ids are refused whatever the store holds. */
async function refusesNewAdmissions(stores: ScimStores, orgId: string) {
  await expect(
    stores.groups.upsert(group(orgId, FRESH, [])),
  ).rejects.toBeInstanceOf(ScimGroupPayloadError);
  await expect(
    stores.groups.upsert(group(orgId, "short", [FRESH])),
  ).rejects.toBeInstanceOf(ScimGroupPayloadError);
  await expect(stores.mappings.put(orgId, FRESH, "member")).rejects.toThrow(
    "Invalid SCIM group id",
  );
  expect(await stores.groups.getById(orgId, FRESH)).toBeNull();
  expect(await stores.mappings.get(orgId, FRESH)).toBeUndefined();
}

it("admits over-long mapping ids only as reductions of an existing mapping", () => {
  expect(scimMappingAdmissible(LEGACY, "member", undefined)).toBe(false);
  expect(scimMappingAdmissible(LEGACY, "member", "owner")).toBe(true);
  expect(scimMappingAdmissible(LEGACY, "admin", "owner")).toBe(true);
  expect(scimMappingAdmissible(LEGACY, "owner", "admin")).toBe(false);
  expect(scimMappingAdmissible("short", "owner", undefined)).toBe(true);
  expect(scimMappingAdmissible("", "member", undefined)).toBe(false);
});

it("refuses new over-long groups, members and mappings in memory", async () => {
  await refusesNewAdmissions(createMemoryScimStores(), "org-one");
});

it("lets a Postgres group and mapping written before the id ceiling be reduced", async () => {
  const { db, repos } = await owner.acquire();
  const principal = await repos.principals.create(makePrincipal());
  const orgId = `org_${randomUUID()}`;
  const now = new Date();
  await createPostgresOrganizationStores(db).organizations.set(orgId, {
    id: orgId,
    slug: orgId,
    displayName: orgId,
    state: "active",
    createdBy: principal.id,
    createdAt: now,
    updatedAt: now,
  });
  // Rows an older release admitted, written past the current store checks.
  await db
    .insert(scimGroups)
    .values(group(orgId, LEGACY, ["short-member", LEGACY_MEMBER]));
  await db.insert(scimGroupRoleMappings).values({
    organizationId: orgId,
    groupId: LEGACY,
    role: "owner",
    createdAt: now,
    updatedAt: now,
  });
  const stores = createPostgresScimStores(db);

  const kept = await stores.groups.upsert(
    group(orgId, LEGACY, [LEGACY_MEMBER]),
  );
  expect(kept.memberIds).toEqual([LEGACY_MEMBER]);
  await expect(
    stores.groups.upsert(group(orgId, LEGACY, [LEGACY_MEMBER, FRESH])),
  ).rejects.toBeInstanceOf(ScimGroupPayloadError);
  const emptied = await stores.groups.upsert(group(orgId, LEGACY, []));
  expect(emptied.memberIds).toEqual([]);
  await expect(
    stores.groups.upsert(group(orgId, LEGACY, [LEGACY_MEMBER])),
  ).rejects.toBeInstanceOf(ScimGroupPayloadError);

  expect(await stores.mappings.removeIfNeutral(orgId, LEGACY)).toBe(
    "mapping_not_neutral",
  );
  await expect(stores.mappings.put(orgId, LEGACY, "owner")).resolves.toEqual({
    organizationId: orgId,
    groupId: LEGACY,
    role: "owner",
  });
  await stores.mappings.put(orgId, LEGACY, "member");
  expect(await stores.mappings.get(orgId, LEGACY)).toBe("member");
  await expect(stores.mappings.put(orgId, LEGACY, "admin")).rejects.toThrow(
    "Invalid SCIM group id",
  );
  expect(await stores.mappings.get(orgId, LEGACY)).toBe("member");
  expect(await stores.mappings.removeIfNeutral(orgId, LEGACY)).toBe("deleted");
  await expect(stores.mappings.put(orgId, LEGACY, "member")).rejects.toThrow(
    "Invalid SCIM group id",
  );

  await refusesNewAdmissions(stores, orgId);
}, 60_000);
