import { randomUUID } from "node:crypto";
import type { OrganizationMembership } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { MemoryOrganizationMembershipStore } from "../src/repos/organization-membership-memory.js";
import type { ScimGroupRecord } from "../src/scim-group-store.js";
import {
  MemoryScimGroupMappingStore,
  MemoryScimGroupStore,
} from "../src/scim-groups-memory.js";
import type { ScimUserRecord } from "../src/scim-store.js";
import { MemoryScimUserStore } from "../src/scim-users-memory.js";

const at = () => new Date("2026-08-24T09:00:00.000Z");

function user(org: string, id: string): ScimUserRecord {
  return {
    id,
    organizationId: org,
    userName: `${id}@example.com`,
    active: true,
    raw: {},
    createdAt: at(),
    updatedAt: at(),
  };
}

function group(org: string, id: string): ScimGroupRecord {
  return {
    id,
    organizationId: org,
    displayName: id,
    memberIds: [],
    createdAt: at(),
    updatedAt: at(),
  };
}

function membership(org: string, id: string): OrganizationMembership {
  return {
    organizationId: org,
    principalId: id,
    role: "member",
    createdAt: at(),
    updatedAt: at(),
  };
}

describe("organization-scoped memory transactions", () => {
  it("stages all stores together, preserves versions, and leaves other tenants untouched", async () => {
    const users = new MemoryScimUserStore();
    const groups = new MemoryScimGroupStore();
    const mappings = new MemoryScimGroupMappingStore();
    const memberships = new MemoryOrganizationMembershipStore();
    const alice = user("org-a", "alice");
    const bob = user("org-b", "bob");
    await users.create(alice);
    await users.create(bob);
    await groups.upsert(group("org-a", "admins"));
    await mappings.put("org-a", "admins", "member");
    memberships.upsert(membership("org-a", "p1"));
    const initialUser = await users.getVersioned("org-a", "alice");
    const initialMembership = memberships.findVersioned("org-a", "p1");
    if (!initialUser || !initialMembership)
      throw new Error("expected seeded rows");

    const userFork = users.forkForTransaction("org-a");
    const groupFork = groups.forkForTransaction("org-a");
    const mappingFork = mappings.forkForTransaction("org-a");
    const memberFork = memberships.forkForTransaction("org-a");
    expect(await userFork.store.getVersioned("org-a", "alice")).toEqual(
      initialUser,
    );
    expect(memberFork.store.findVersioned("org-a", "p1")).toEqual(
      initialMembership,
    );
    await userFork.store.update({ ...alice, active: false });
    await groupFork.store.upsert({
      ...group("org-a", "admins"),
      memberIds: ["alice"],
    });
    await mappingFork.store.put("org-a", "admins", "admin");
    const intent = {
      id: randomUUID(),
      kind: "remove" as const,
      reason: "scim_deactivated" as const,
      actorType: "system" as const,
      actorPrincipalId: "directory",
      correlationId: "request",
    };
    expect(
      memberFork.store.beginWithdrawal(
        "org-a",
        "p1",
        initialMembership.incarnation,
        initialMembership.authorityRevision,
        intent,
      ),
    ).toBe(true);
    const stagedUser = await userFork.store.getVersioned("org-a", "alice");
    const stagedMembership = memberFork.store.findVersioned("org-a", "p1");
    expect(await users.getVersioned("org-a", "alice")).toEqual(initialUser);
    expect(memberships.findVersioned("org-a", "p1")).toEqual(initialMembership);

    await users.update({ ...bob, active: false });
    await groups.upsert(group("org-b", "other"));
    await mappings.put("org-b", "other", "owner");
    memberships.upsert(membership("org-b", "p2"));
    const forks = [userFork, groupFork, mappingFork, memberFork];
    expect(forks.every((fork) => fork.validate())).toBe(true);
    for (const fork of forks) fork.commit();
    expect(await users.getVersioned("org-a", "alice")).toEqual(stagedUser);
    expect(memberships.findVersioned("org-a", "p1")).toEqual(stagedMembership);
    expect((await groups.getById("org-a", "admins"))?.memberIds).toEqual([
      "alice",
    ]);
    expect(await mappings.get("org-a", "admins")).toBe("admin");
    expect((await users.getById("org-b", "bob"))?.active).toBe(false);
    expect(await groups.getById("org-b", "other")).not.toBeNull();
    expect(await mappings.get("org-b", "other")).toBe("owner");
    expect(memberships.find("org-b", "p2")).toBeDefined();
  });

  it("rejects stale forks, including concurrent changes to pending membership metadata", async () => {
    const memberships = new MemoryOrganizationMembershipStore();
    const row = membership("org-a", "p1");
    memberships.upsert(row);
    const initial = memberships.findVersioned("org-a", "p1");
    if (!initial) throw new Error("expected membership");
    const fork = memberships.forkForTransaction("org-a");
    fork.store.upsert({ ...row, role: "admin" });
    const intent = {
      id: randomUUID(),
      kind: "remove" as const,
      actorType: "human" as const,
      actorPrincipalId: "owner",
      correlationId: "request",
    };
    expect(
      memberships.beginWithdrawal(
        "org-a",
        "p1",
        initial.incarnation,
        initial.authorityRevision,
        intent,
      ),
    ).toBe(true);
    expect(fork.validate()).toBe(false);
    expect(() => fork.commit()).toThrow("stale");
    expect(memberships.findVersioned("org-a", "p1")).toEqual({
      ...initial,
      withdrawalId: intent.id,
      withdrawal: intent,
    });
    expect(() => fork.store.upsert(membership("org-b", "p2"))).toThrow(
      "another organization",
    );
  });

  it("does not overwrite a user id concurrently created in another organization", async () => {
    const users = new MemoryScimUserStore();
    const fork = users.forkForTransaction("org-a");
    await fork.store.create(user("org-a", "same-id"));
    await users.create(user("org-b", "same-id"));
    expect(fork.validate()).toBe(false);
    expect(() => fork.commit()).toThrow("stale");
    expect(await users.getById("org-a", "same-id")).toBeNull();
    expect(await users.getById("org-b", "same-id")).not.toBeNull();
    await expect(fork.store.create(user("org-b", "other"))).rejects.toThrow(
      "another organization",
    );
  });
});
