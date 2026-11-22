import type { OrganizationRole } from "@opensesame/os-domain";
import type { MemoryStoreFork } from "./memory-transaction.js";
import { ConflictError } from "./repos/interfaces.js";
import {
  ScimAdminCapacityError,
  type ScimAdminLimits,
  type ScimListPage,
  scimAdminLimits,
  scimAdminPage,
} from "./scim-admin-limits.js";
import {
  ScimGroupCapacityError,
  type ScimGroupLimits,
  scimGroupLimits,
  scimMappingAdmissible,
} from "./scim-group-limits.js";
import type {
  ScimGroupMapping,
  ScimGroupMappingStore,
  ScimGroupRecord,
  ScimGroupStore,
} from "./scim-group-store.js";
import {
  cloneGroup,
  groupKey,
  normalizeGroup,
  validateGroup,
} from "./scim-group-values.js";

/**
 * A fork sees only its tenant's rows; it remembers how many other tenants held
 * when it was taken, and its commit is refused if that has since grown past
 * the deployment-wide bound.
 */
function deploymentFits(
  staged: number,
  current: number,
  outside: number,
  limit: number,
): boolean {
  return staged <= current || outside + staged <= limit;
}

export class MemoryScimGroupStore implements ScimGroupStore {
  readonly #groups = new Map<string, ScimGroupRecord>();
  readonly #generations = new Map<string, bigint>();
  readonly #limits: ScimGroupLimits;
  #scope: string | undefined;
  #outside = 0;

  constructor(options?: Partial<ScimGroupLimits>) {
    this.#limits = scimGroupLimits(options);
  }

  private ofOrg(orgId: string): ScimGroupRecord[] {
    return [...this.#groups.values()].filter(
      (group) => group.organizationId === orgId,
    );
  }

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
    const key = groupKey(row.organizationId, row.id);
    validateGroup(row, this.#groups.get(key)?.memberIds);
    if (
      !this.#groups.has(key) &&
      (this.ofOrg(row.organizationId).length >= this.#limits.perOrganization ||
        this.#outside + this.#groups.size >= this.#limits.perDeployment)
    )
      throw new ScimGroupCapacityError();
    this.#groups.set(key, row);
    this.touch(row.organizationId);
    return cloneGroup(row);
  }

  async getById(orgId: string, id: string): Promise<ScimGroupRecord | null> {
    const row = this.#groups.get(groupKey(orgId, id));
    return row ? cloneGroup(row) : null;
  }

  async listByOrganization(orgId: string): Promise<ScimGroupRecord[]> {
    return this.ofOrg(orgId)
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
    const staged = new MemoryScimGroupStore(this.#limits);
    staged.#scope = orgId;
    for (const [key, row] of this.#groups) {
      if (row.organizationId === orgId)
        staged.#groups.set(key, cloneGroup(row));
    }
    staged.#outside = this.#groups.size - staged.#groups.size;
    const validate = () => {
      const current = this.ofOrg(orgId).length;
      return (
        (this.#generations.get(orgId) ?? 0n) === expected &&
        deploymentFits(
          staged.#groups.size,
          current,
          this.#groups.size - current,
          this.#limits.perDeployment,
        )
      );
    };
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
  readonly #limits: ScimAdminLimits;
  #scope: string | undefined;
  #outside = 0;

  constructor(options?: Partial<ScimAdminLimits>) {
    this.#limits = scimAdminLimits(options);
  }

  private ofOrg(orgId: string): ScimGroupMapping[] {
    return [...this.#mappings.values()].filter(
      (row) => row.organizationId === orgId,
    );
  }

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
    const key = groupKey(orgId, groupId);
    // New or raised over-long mappings are refused; reductions stay possible.
    if (!scimMappingAdmissible(groupId, role, this.#mappings.get(key)?.role))
      throw new Error("Invalid SCIM group id");
    if (
      !this.#mappings.has(key) &&
      (this.ofOrg(orgId).length >= this.#limits.mappingsPerOrganization ||
        this.#outside + this.#mappings.size >=
          this.#limits.mappingsPerDeployment)
    )
      throw new ScimAdminCapacityError();
    const row = { organizationId: orgId, groupId, role };
    this.#mappings.set(key, row);
    this.touch(orgId);
    return { ...row };
  }

  async get(
    orgId: string,
    groupId: string,
  ): Promise<OrganizationRole | undefined> {
    return this.#mappings.get(groupKey(orgId, groupId))?.role;
  }

  async count(orgId: string): Promise<number> {
    return this.ofOrg(orgId).length;
  }

  async listByOrganization(
    orgId: string,
    input?: ScimListPage,
  ): Promise<ScimGroupMapping[]> {
    const page = scimAdminPage(input);
    return this.ofOrg(orgId)
      .sort((a, b) =>
        a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0,
      )
      .slice(page.offset, page.offset + page.limit)
      .map((row) => ({ ...row }));
  }

  /** Removing a neutral mapping cannot confer additional authority. */
  async removeIfNeutral(
    orgId: string,
    groupId: string,
  ): Promise<"deleted" | "not_found" | "mapping_not_neutral"> {
    this.checkScope(orgId);
    const key = groupKey(orgId, groupId);
    const row = this.#mappings.get(key);
    if (!row) return "not_found";
    if (row.role !== "member") return "mapping_not_neutral";
    this.#mappings.delete(key);
    this.touch(orgId);
    return "deleted";
  }

  forkForTransaction(
    orgId: string,
  ): MemoryStoreFork<MemoryScimGroupMappingStore> {
    if (this.#scope !== undefined)
      throw new Error("SCIM transaction cannot be forked");
    const expected = this.#generations.get(orgId) ?? 0n;
    const staged = new MemoryScimGroupMappingStore(this.#limits);
    staged.#scope = orgId;
    for (const [key, row] of this.#mappings) {
      if (row.organizationId === orgId) staged.#mappings.set(key, { ...row });
    }
    staged.#outside = this.#mappings.size - staged.#mappings.size;
    const validate = () => {
      const current = this.ofOrg(orgId).length;
      return (
        (this.#generations.get(orgId) ?? 0n) === expected &&
        deploymentFits(
          staged.#mappings.size,
          current,
          this.#mappings.size - current,
          this.#limits.mappingsPerDeployment,
        )
      );
    };
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
