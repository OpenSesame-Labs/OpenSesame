import {
  SCIM_GROUP_ID_MAX,
  type ScimGroupMappingStore,
  type ScimGroupRecord,
  type ScimGroupStore,
  type ScimStores,
  createMemoryScimStores,
} from "@opensesame/database";
import type { OrganizationRole } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { roleOf } from "../routes/scim-effects.js";
import {
  groupsPath,
  json,
  mintScimToken,
  patchScim,
  provisionUser,
  provisional,
} from "./scim-test-helpers.js";

// Group ids admitted before the ceiling existed may exceed it. The stores
// refuse to create such rows now, so these tests hold the legacy rows beside
// the real memory stores, as a database written by an older release would.
const LEGACY = `legacy-${"g".repeat(SCIM_GROUP_ID_MAX)}`;
const LEGACY_MEMBER = `member-${"m".repeat(SCIM_GROUP_ID_MAX)}`;

/** The rows an older release left behind for the over-long group id. */
interface LegacyRows {
  group?: ScimGroupRecord;
  role?: OrganizationRole;
}

function withLegacyRows(base: ScimStores) {
  const legacy: LegacyRows = {};
  const copy = (group: ScimGroupRecord) => ({
    ...group,
    memberIds: [...group.memberIds],
  });
  const groups: ScimGroupStore = {
    async upsert(group) {
      if (group.id !== LEGACY) return base.groups.upsert(group);
      legacy.group = copy(group);
      return copy(group);
    },
    async getById(orgId, id) {
      if (id !== LEGACY) return base.groups.getById(orgId, id);
      return legacy.group?.organizationId === orgId ? copy(legacy.group) : null;
    },
    async listByOrganization(orgId) {
      const rows = await base.groups.listByOrganization(orgId);
      const row = await groups.getById(orgId, LEGACY);
      return row ? [...rows, row] : rows;
    },
    async listByMember(orgId, memberId) {
      const rows = await base.groups.listByMember(orgId, memberId);
      const row = await groups.getById(orgId, LEGACY);
      return row?.memberIds.includes(memberId) ? [...rows, row] : rows;
    },
  };
  const mappings: ScimGroupMappingStore = {
    ...base.mappings,
    async put(orgId, groupId, role) {
      if (groupId !== LEGACY) return base.mappings.put(orgId, groupId, role);
      legacy.role = role;
      return { organizationId: orgId, groupId, role };
    },
    async get(orgId, groupId) {
      if (groupId !== LEGACY) return base.mappings.get(orgId, groupId);
      return legacy.role;
    },
    async removeIfNeutral(orgId, groupId) {
      if (groupId !== LEGACY)
        return base.mappings.removeIfNeutral(orgId, groupId);
      if (!legacy.role) return "not_found";
      if (legacy.role !== "member") return "mapping_not_neutral";
      legacy.role = undefined;
      return "deleted";
    },
  };
  return { stores: { ...base, groups, mappings }, legacy };
}

async function fixture() {
  const { stores, legacy } = withLegacyRows(createMemoryScimStores());
  const plane = createControlPlane({ scimStores: stores });
  const owner = await provisional(plane.app);
  const [membership] =
    await plane.ctx.stores.organizationMemberships.listByPrincipal(
      String(owner.principalId),
    );
  if (!membership) throw new Error("Fixture organization missing");
  const orgId = membership.organizationId;
  const bearer = String(owner.accessToken);
  const { token } = await mintScimToken(plane.app, orgId, bearer);
  const user = await provisionUser(plane.app, orgId, token, {
    userName: "legacy@example.test",
  });
  expect(user.status).toBe(201);
  const userId = String(user.body.id);
  const now = new Date();
  legacy.group = {
    id: LEGACY,
    organizationId: orgId,
    displayName: "Legacy owners",
    memberIds: [LEGACY_MEMBER],
    createdAt: now,
    updatedAt: now,
  };
  legacy.role = "owner";
  const mapping = (method: string, id: string, role?: OrganizationRole) => {
    const init: RequestInit = { method, headers: json(bearer) };
    if (role) init.body = JSON.stringify({ role });
    return plane.app.request(
      `/v1/organizations/${orgId}/scim/mappings/${encodeURIComponent(id)}`,
      init,
    );
  };
  const roleOfUser = async () => {
    const row = await plane.ctx.stores.scim.users.getById(orgId, userId);
    if (!row) throw new Error("Provisioned user missing");
    return roleOf(row);
  };
  return { ...plane, orgId, token, userId, legacy, mapping, roleOfUser };
}

it("lets an over-long legacy group shed members and the privilege they hold", async () => {
  const f = await fixture();
  const path = groupsPath(f.orgId, LEGACY);
  const added = await patchScim(f.app, path, f.token, [
    { op: "add", path: "members", value: [{ value: f.userId }] },
  ]);
  expect(added.status).toBe(200);
  expect(await f.roleOfUser()).toBe("owner");

  const removed = await patchScim(f.app, path, f.token, [
    { op: "remove", path: `members[value eq "${f.userId}"]` },
    { op: "remove", path: "members", value: [{ value: LEGACY_MEMBER }] },
  ]);
  expect(removed.status).toBe(200);
  expect(f.legacy.group?.memberIds).toEqual([]);
  expect(await f.roleOfUser()).toBeUndefined();
});

it("still refuses new over-long groups and new over-long members", async () => {
  const f = await fixture();
  const fresh = `fresh-${"x".repeat(SCIM_GROUP_ID_MAX)}`;
  const created = await patchScim(f.app, groupsPath(f.orgId, fresh), f.token, [
    { op: "add", path: "members", value: [{ value: f.userId }] },
  ]);
  expect(created.status).toBe(400);
  expect(await f.ctx.stores.scim.groups.getById(f.orgId, fresh)).toBeNull();

  const longMember = `new-${"n".repeat(SCIM_GROUP_ID_MAX)}`;
  for (const group of [LEGACY, "short"]) {
    const refused = await patchScim(
      f.app,
      groupsPath(f.orgId, group),
      f.token,
      [{ op: "add", path: "members", value: [{ value: longMember }] }],
    );
    expect(refused.status).toBe(400);
  }
  expect(f.legacy.group?.memberIds).toEqual([LEGACY_MEMBER]);
  expect(await f.ctx.stores.scim.groups.getById(f.orgId, "short")).toBeNull();
});

it("lets an owner neutralize and delete a legacy mapping but not raise or create one", async () => {
  const f = await fixture();
  expect((await f.mapping("PUT", LEGACY, "owner")).status).toBe(200);
  expect((await f.mapping("DELETE", LEGACY)).status).toBe(409);
  expect((await f.mapping("PUT", LEGACY, "member")).status).toBe(200);
  expect(f.legacy.role).toBe("member");
  expect((await f.mapping("PUT", LEGACY, "admin")).status).toBe(400);
  expect(f.legacy.role).toBe("member");
  expect((await f.mapping("DELETE", LEGACY)).status).toBe(204);
  expect(f.legacy.role).toBeUndefined();
  expect((await f.mapping("PUT", LEGACY, "member")).status).toBe(400);

  const fresh = `fresh-${"x".repeat(SCIM_GROUP_ID_MAX)}`;
  expect((await f.mapping("PUT", fresh, "member")).status).toBe(400);
  expect(await f.ctx.stores.scim.mappings.get(f.orgId, fresh)).toBeUndefined();
  expect((await f.mapping("DELETE", fresh)).status).toBe(404);
});
