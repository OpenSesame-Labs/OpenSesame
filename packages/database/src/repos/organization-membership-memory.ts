import { randomUUID } from "node:crypto";
import type {
  OrganizationMembership,
  OrganizationRole,
} from "@opensesame/os-domain";
import type { MemoryStoreFork } from "../memory-transaction.js";
import { ConflictError } from "./errors.js";
import type {
  OrganizationMembershipStore,
  OrganizationMembershipWithdrawal,
  PendingOrganizationMembershipWithdrawal,
  VersionedOrganizationMembership,
} from "./organization-interfaces.js";
import {
  cloneMembership,
  organizationMembershipKey,
} from "./organization-membership-memory-values.js";
import { validOrganizationWithdrawal } from "./organization-withdrawal.js";

/**
 * In-memory membership rows. The Map API remains available for test seeding,
 * and rows seeded through it are visible through the store interface.
 */
export class MemoryOrganizationMembershipStore
  extends Map<string, OrganizationMembership>
  implements OrganizationMembershipStore
{
  readonly #incarnations = new Map<string, string>();
  readonly #authorityRevisions = new Map<string, string>();
  readonly #withdrawals = new Map<string, OrganizationMembershipWithdrawal>();
  readonly #generations = new Map<string, bigint>();
  #scope: string | undefined;

  private checkScope(organizationId: string): void {
    if (this.#scope !== undefined && this.#scope !== organizationId) {
      throw new Error(
        "membership transaction cannot modify another organization",
      );
    }
  }

  private touch(organizationId: string): void {
    this.#generations.set(
      organizationId,
      (this.#generations.get(organizationId) ?? 0n) + 1n,
    );
  }

  constructor(
    entries?: Iterable<readonly [string, OrganizationMembership]> | null,
  ) {
    // Map's iterable constructor calls `set` before subclass fields exist.
    super();
    if (entries != null) {
      for (const entry of entries) this.set(entry[0], entry[1]);
    }
  }

  override set(key: string, membership: OrganizationMembership): this {
    const existing = super.get(key);
    this.checkScope(membership.organizationId);
    if (existing) this.checkScope(existing.organizationId);
    if (this.#withdrawals.has(key))
      throw new ConflictError("membership withdrawal in progress");
    if (!existing) {
      this.#incarnations.set(key, randomUUID());
      this.#authorityRevisions.set(key, randomUUID());
    } else if (existing.role !== membership.role) {
      this.#authorityRevisions.set(key, randomUUID());
    }
    const result = super.set(key, cloneMembership(membership));
    if (existing && existing.organizationId !== membership.organizationId)
      this.touch(existing.organizationId);
    this.touch(membership.organizationId);
    return result;
  }

  override delete(key: string): boolean {
    const existing = super.get(key);
    if (existing) this.checkScope(existing.organizationId);
    const deleted = super.delete(key);
    if (deleted) {
      this.#incarnations.delete(key);
      this.#authorityRevisions.delete(key);
      this.#withdrawals.delete(key);
      if (existing) this.touch(existing.organizationId);
    }
    return deleted;
  }

  override clear(): void {
    const organizations = new Set(
      [...super.values()].map((row) => row.organizationId),
    );
    for (const organizationId of organizations) this.checkScope(organizationId);
    super.clear();
    this.#incarnations.clear();
    this.#authorityRevisions.clear();
    this.#withdrawals.clear();
    for (const organizationId of organizations) this.touch(organizationId);
  }

  find(
    organizationId: string,
    principalId: string,
  ): OrganizationMembership | undefined {
    const row = super.get(
      organizationMembershipKey(organizationId, principalId),
    );
    return row ? cloneMembership(row) : undefined;
  }

  private versioned(
    key: string,
    membership: OrganizationMembership,
  ): VersionedOrganizationMembership {
    const incarnation = this.#incarnations.get(key);
    const authorityRevision = this.#authorityRevisions.get(key);
    if (!incarnation || !authorityRevision)
      throw new Error("membership version is missing");
    const withdrawal = this.#withdrawals.get(key);
    return {
      membership: cloneMembership(membership),
      incarnation,
      authorityRevision,
      ...(withdrawal
        ? { withdrawalId: withdrawal.id, withdrawal: { ...withdrawal } }
        : undefined),
    };
  }

  findVersioned(
    organizationId: string,
    principalId: string,
  ): VersionedOrganizationMembership | undefined {
    const key = organizationMembershipKey(organizationId, principalId);
    const membership = super.get(key);
    if (!membership) return undefined;
    return this.versioned(key, membership);
  }

  upsert(membership: OrganizationMembership): OrganizationMembership {
    this.set(
      organizationMembershipKey(
        membership.organizationId,
        membership.principalId,
      ),
      membership,
    );
    return cloneMembership(membership);
  }

  remove(organizationId: string, principalId: string): boolean {
    const key = organizationMembershipKey(organizationId, principalId);
    return !this.#withdrawals.has(key) && this.delete(key);
  }

  removeIfIncarnation(
    organizationId: string,
    principalId: string,
    incarnation: string,
    withdrawalId?: string,
  ): boolean {
    const key = organizationMembershipKey(organizationId, principalId);
    const current = this.#incarnations.get(key);
    const withdrawal = this.#withdrawals.get(key);
    return (
      current !== undefined &&
      current === incarnation &&
      withdrawal?.id === withdrawalId &&
      (withdrawal === undefined || withdrawal.kind === "remove") &&
      this.delete(key)
    );
  }

  beginWithdrawal(
    organizationId: string,
    principalId: string,
    incarnation: string,
    authorityRevision: string,
    withdrawal: OrganizationMembershipWithdrawal,
  ): boolean {
    this.checkScope(organizationId);
    const key = organizationMembershipKey(organizationId, principalId);
    const current = this.#incarnations.get(key);
    if (
      !validOrganizationWithdrawal(withdrawal) ||
      current === undefined ||
      current !== incarnation ||
      this.#authorityRevisions.get(key) !== authorityRevision ||
      this.#withdrawals.has(key)
    ) {
      return false;
    }
    this.#withdrawals.set(key, { ...withdrawal });
    this.touch(organizationId);
    return true;
  }

  clearWithdrawal(
    organizationId: string,
    principalId: string,
    incarnation: string,
    withdrawalId: string,
  ): boolean {
    this.checkScope(organizationId);
    const key = organizationMembershipKey(organizationId, principalId);
    if (
      this.#incarnations.get(key) !== incarnation ||
      this.#withdrawals.get(key)?.id !== withdrawalId
    ) {
      return false;
    }
    this.#withdrawals.delete(key);
    this.touch(organizationId);
    return true;
  }

  completeRoleWithdrawal(
    organizationId: string,
    principalId: string,
    incarnation: string,
    withdrawalId: string,
    role: OrganizationRole,
    updatedAt: Date,
  ): VersionedOrganizationMembership | undefined {
    this.checkScope(organizationId);
    const key = organizationMembershipKey(organizationId, principalId);
    const membership = super.get(key);
    const withdrawal = this.#withdrawals.get(key);
    if (
      !membership ||
      this.#incarnations.get(key) !== incarnation ||
      !withdrawal ||
      withdrawal.id !== withdrawalId ||
      withdrawal.kind !== "change_role" ||
      withdrawal.role !== role
    )
      return undefined;
    const updated = cloneMembership({ ...membership, role, updatedAt });
    this.#withdrawals.delete(key);
    this.#authorityRevisions.set(key, randomUUID());
    super.set(key, updated);
    this.touch(organizationId);
    return this.versioned(key, updated);
  }

  upgradeRoleWithdrawalToRemoval(
    organizationId: string,
    principalId: string,
    incarnation: string,
    authorityRevision: string,
    previousWithdrawalId: string,
    withdrawal: OrganizationMembershipWithdrawal,
  ): boolean {
    this.checkScope(organizationId);
    const key = organizationMembershipKey(organizationId, principalId);
    const previous = this.#withdrawals.get(key);
    if (
      !validOrganizationWithdrawal(withdrawal) ||
      withdrawal.kind !== "remove" ||
      withdrawal.actorType !== "system" ||
      withdrawal.id !== previousWithdrawalId ||
      this.#incarnations.get(key) !== incarnation ||
      this.#authorityRevisions.get(key) !== authorityRevision ||
      previous?.id !== previousWithdrawalId ||
      previous.kind !== "change_role"
    )
      return false;
    this.#withdrawals.set(key, { ...withdrawal });
    this.touch(organizationId);
    return true;
  }

  listPendingWithdrawals(): PendingOrganizationMembershipWithdrawal[] {
    const rows: PendingOrganizationMembershipWithdrawal[] = [];
    for (const [key, withdrawal] of this.#withdrawals) {
      const membership = super.get(key);
      if (!membership) throw new Error("withdrawing membership is missing");
      rows.push({
        ...this.versioned(key, membership),
        withdrawalId: withdrawal.id,
        withdrawal: { ...withdrawal },
      });
    }
    return rows;
  }

  hasPendingWithdrawalForPrincipal(principalId: string): boolean {
    for (const key of this.#withdrawals.keys()) {
      if (super.get(key)?.principalId === principalId) return true;
    }
    return false;
  }

  forkForTransaction(
    organizationId: string,
  ): MemoryStoreFork<MemoryOrganizationMembershipStore> {
    if (this.#scope !== undefined)
      throw new Error("membership transaction cannot be forked");
    const expected = this.#generations.get(organizationId) ?? 0n;
    const staged = new MemoryOrganizationMembershipStore();
    staged.#scope = organizationId;
    for (const [key, row] of this) {
      if (row.organizationId !== organizationId) continue;
      Map.prototype.set.call(staged, key, cloneMembership(row));
      const incarnation = this.#incarnations.get(key);
      const revision = this.#authorityRevisions.get(key);
      if (!incarnation || !revision)
        throw new Error("membership version is missing");
      staged.#incarnations.set(key, incarnation);
      staged.#authorityRevisions.set(key, revision);
      const withdrawal = this.#withdrawals.get(key);
      if (withdrawal) staged.#withdrawals.set(key, { ...withdrawal });
    }
    const validate = () => {
      if ((this.#generations.get(organizationId) ?? 0n) !== expected)
        return false;
      for (const [key, row] of staged) {
        if (
          row.organizationId !== organizationId ||
          !staged.#incarnations.has(key) ||
          !staged.#authorityRevisions.has(key)
        )
          return false;
        const current = super.get(key);
        if (current && current.organizationId !== organizationId) return false;
      }
      return true;
    };
    return {
      store: staged,
      validate,
      commit: () => {
        if (!validate())
          throw new ConflictError("membership transaction is stale");
        if ((staged.#generations.get(organizationId) ?? 0n) === 0n) return;
        for (const [key, row] of this) {
          if (row.organizationId !== organizationId) continue;
          Map.prototype.delete.call(this, key);
          this.#incarnations.delete(key);
          this.#authorityRevisions.delete(key);
          this.#withdrawals.delete(key);
        }
        for (const [key, row] of staged) {
          Map.prototype.set.call(this, key, cloneMembership(row));
          const incarnation = staged.#incarnations.get(key);
          const revision = staged.#authorityRevisions.get(key);
          if (!incarnation || !revision)
            throw new Error("membership version is missing");
          this.#incarnations.set(key, incarnation);
          this.#authorityRevisions.set(key, revision);
          const withdrawal = staged.#withdrawals.get(key);
          if (withdrawal) this.#withdrawals.set(key, { ...withdrawal });
        }
        this.touch(organizationId);
      },
    };
  }

  listByOrganization(organizationId: string): OrganizationMembership[] {
    return [...this.values()]
      .filter((m) => m.organizationId === organizationId)
      .map(cloneMembership);
  }

  listVersionedByOrganization(
    organizationId: string,
  ): VersionedOrganizationMembership[] {
    const rows: VersionedOrganizationMembership[] = [];
    for (const [key, membership] of this) {
      if (membership.organizationId !== organizationId) continue;
      rows.push(this.versioned(key, membership));
    }
    return rows;
  }

  listByPrincipal(principalId: string): OrganizationMembership[] {
    return [...this.values()]
      .filter((m) => m.principalId === principalId)
      .map(cloneMembership);
  }

  countOwners(organizationId: string): number {
    let count = 0;
    for (const membership of this.values()) {
      if (
        membership.organizationId === organizationId &&
        membership.role === "owner"
      ) {
        count += 1;
      }
    }
    return count;
  }
}
