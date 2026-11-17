import type { OrganizationRole } from "@opensesame/os-domain";
import type { MemoryStoreFork } from "./memory-transaction.js";
import { ConflictError } from "./repos/interfaces.js";
import type {
  ScimGroupMapping,
  ScimGroupMappingStore,
  ScimGroupRecord,
  ScimGroupStore,
} from "./scim-group-store.js";
import { cloneGroup, groupKey, normalizeGroup } from "./scim-group-values.js";

export class MemoryScimGroupStore implements ScimGroupStore {
  readonly #groups = new Map<string, ScimGroupRecord>();
  readonly #generations = new Map<string, bigint>();
  #scope: string | undefined;

  private checkScope(orgId: string): void {
    if (this.#scope !== undefined && this.#scope !== orgId) {
      throw new Error("SCIM transaction cannot modify another organization");
    }
  }

  private touch(orgId: string): void {
    this.#generations.set(orgId, (this.#generations.get(orgId) ?? 0n) + 1n);
  }

  async upsert(group: ScimGroupRecord): Promise<ScimGroupRecord> {
    this.checkScope(group.organizationId);
    const row = normalizeGroup(group);
    this.#groups.set(groupKey(row.organizationId, row.id), row);
    this.touch(row.organizationId);
    return cloneGroup(row);
  }

  async getById(orgId: string, id: string): Promise<ScimGroupRecord | null> {
    const row = this.#groups.get(groupKey(orgId, id));
    return row ? cloneGroup(row) : null;
  }

  async listByOrganization(orgId: string): Promise<ScimGroupRecord[]> {
    return [...this.#groups.values()]
      .filter((group) => group.organizationId === orgId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(cloneGroup);
  }

  async listByMember(
    orgId: string,
    memberId: string,
  ): Promise<ScimGroupRecord[]> {
    return (await this.listByOrganization(orgId)).filter((group) =>
      group.memberIds.includes(memberId),
    );
  }

  forkForTransaction(orgId: string): MemoryStoreFork<MemoryScimGroupStore> {
    if (this.#scope !== undefined)
      throw new Error("SCIM transaction cannot be forked");
    const expected = this.#generations.get(orgId) ?? 0n;
    const staged = new MemoryScimGroupStore();
    staged.#scope = orgId;
    for (const [key, row] of this.#groups) {
      if (row.organizationId === orgId)
        staged.#groups.set(key, cloneGroup(row));
    }
    const validate = () => (this.#generations.get(orgId) ?? 0n) === expected;
    return {
      store: staged,
      validate,
      commit: () => {
        if (!validate())
          throw new ConflictError("SCIM group transaction is stale");
        if ((staged.#generations.get(orgId) ?? 0n) === 0n) return;
        for (const [key, row] of this.#groups) {
          if (row.organizationId === orgId) this.#groups.delete(key);
        }
        for (const [key, row] of staged.#groups)
          this.#groups.set(key, cloneGroup(row));
        this.touch(orgId);
      },
    };
  }
}

export class MemoryScimGroupMappingStore implements ScimGroupMappingStore {
  readonly #mappings = new Map<string, ScimGroupMapping>();
  readonly #generations = new Map<string, bigint>();
  #scope: string | undefined;

  private checkScope(orgId: string): void {
    if (this.#scope !== undefined && this.#scope !== orgId) {
      throw new Error("SCIM transaction cannot modify another organization");
    }
  }

  private touch(orgId: string): void {
    this.#generations.set(orgId, (this.#generations.get(orgId) ?? 0n) + 1n);
  }

  async put(
    orgId: string,
    groupId: string,
    role: OrganizationRole,
  ): Promise<ScimGroupMapping> {
    this.checkScope(orgId);
    const row = { organizationId: orgId, groupId, role };
    this.#mappings.set(groupKey(orgId, groupId), row);
    this.touch(orgId);
    return { ...row };
  }

  async get(
    orgId: string,
    groupId: string,
  ): Promise<OrganizationRole | undefined> {
    return this.#mappings.get(groupKey(orgId, groupId))?.role;
  }

  async listByOrganization(orgId: string): Promise<ScimGroupMapping[]> {
    return [...this.#mappings.values()]
      .filter((row) => row.organizationId === orgId)
      .sort((a, b) => (a.groupId < b.groupId ? -1 : 1))
      .map((row) => ({ ...row }));
  }

  forkForTransaction(
    orgId: string,
  ): MemoryStoreFork<MemoryScimGroupMappingStore> {
    if (this.#scope !== undefined)
      throw new Error("SCIM transaction cannot be forked");
    const expected = this.#generations.get(orgId) ?? 0n;
    const staged = new MemoryScimGroupMappingStore();
    staged.#scope = orgId;
    for (const [key, row] of this.#mappings) {
      if (row.organizationId === orgId) staged.#mappings.set(key, { ...row });
    }
    const validate = () => (this.#generations.get(orgId) ?? 0n) === expected;
    return {
      store: staged,
      validate,
      commit: () => {
        if (!validate())
          throw new ConflictError("SCIM mapping transaction is stale");
        if ((staged.#generations.get(orgId) ?? 0n) === 0n) return;
        for (const [key, row] of this.#mappings) {
          if (row.organizationId === orgId) this.#mappings.delete(key);
        }
        for (const [key, row] of staged.#mappings)
          this.#mappings.set(key, { ...row });
        this.touch(orgId);
      },
    };
  }
}
