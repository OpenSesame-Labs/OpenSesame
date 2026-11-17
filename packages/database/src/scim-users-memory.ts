import { randomUUID } from "node:crypto";
import type { MemoryStoreFork } from "./memory-transaction.js";
import { ConflictError } from "./repos/interfaces.js";
import type {
  ScimUserRecord,
  ScimUserStore,
  VersionedScimUser,
} from "./scim-store.js";
import { assertScimIdentity, normalizeScimUser } from "./scim-users-common.js";

export class MemoryScimUserStore implements ScimUserStore {
  readonly #users = new Map<string, VersionedScimUser>();
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

  private ofOrg(orgId: string): ScimUserRecord[] {
    return [...this.#users.values()]
      .map(({ user }) => user)
      .filter((user) => user.organizationId === orgId);
  }

  private checkUserName(row: ScimUserRecord): void {
    if (
      this.ofOrg(row.organizationId).some(
        (existing) =>
          existing.id !== row.id && existing.userName === row.userName,
      )
    ) {
      throw new ConflictError(`scim user already exists: ${row.userName}`);
    }
  }

  async create(user: ScimUserRecord): Promise<ScimUserRecord> {
    this.checkScope(user.organizationId);
    const row = normalizeScimUser(user);
    if (this.#users.has(row.id)) {
      throw new ConflictError(`scim user already exists: ${row.userName}`);
    }
    this.checkUserName(row);
    this.#users.set(row.id, { user: row, revision: randomUUID() });
    this.touch(row.organizationId);
    return normalizeScimUser(row);
  }

  async createWithinLimit(
    user: ScimUserRecord,
    limit: number,
  ): Promise<ScimUserRecord | null> {
    this.checkScope(user.organizationId);
    const row = normalizeScimUser(user);
    if (this.#users.has(row.id)) {
      throw new ConflictError(`scim user already exists: ${row.userName}`);
    }
    this.checkUserName(row);
    if (this.ofOrg(row.organizationId).length >= limit) return null;
    this.#users.set(row.id, { user: row, revision: randomUUID() });
    this.touch(row.organizationId);
    return normalizeScimUser(row);
  }

  async countByOrganization(orgId: string): Promise<number> {
    return this.ofOrg(orgId).length;
  }

  async getById(orgId: string, id: string): Promise<ScimUserRecord | null> {
    const row = this.#users.get(id)?.user;
    return row && row.organizationId === orgId ? normalizeScimUser(row) : null;
  }

  async getVersioned(
    orgId: string,
    id: string,
  ): Promise<VersionedScimUser | null> {
    const row = this.#users.get(id);
    return row && row.user.organizationId === orgId
      ? { user: normalizeScimUser(row.user), revision: row.revision }
      : null;
  }

  async findByUserName(
    orgId: string,
    userName: string,
  ): Promise<ScimUserRecord | null> {
    const row = this.ofOrg(orgId).find((user) => user.userName === userName);
    return row ? normalizeScimUser(row) : null;
  }

  async findBySubject(
    orgId: string,
    subject: string,
  ): Promise<ScimUserRecord | null> {
    const scoped = this.ofOrg(orgId);
    const row =
      scoped.find((user) => user.externalId === subject) ??
      scoped.find((user) => user.userName === subject);
    return row ? normalizeScimUser(row) : null;
  }

  async update(user: ScimUserRecord): Promise<ScimUserRecord> {
    this.checkScope(user.organizationId);
    const existing = this.#users.get(user.id);
    if (!existing || existing.user.organizationId !== user.organizationId) {
      throw new ConflictError(`scim user not found: ${user.id}`);
    }
    const row = normalizeScimUser({
      ...user,
      createdAt: existing.user.createdAt,
    });
    this.checkUserName(row);
    this.#users.set(row.id, { user: row, revision: randomUUID() });
    this.touch(row.organizationId);
    return normalizeScimUser(row);
  }

  async replaceIfRevision(
    orgId: string,
    id: string,
    expectedRevision: string,
    next: ScimUserRecord,
  ): Promise<VersionedScimUser | undefined> {
    this.checkScope(orgId);
    assertScimIdentity(orgId, id, next);
    const existing = this.#users.get(id);
    if (
      !existing ||
      existing.user.organizationId !== orgId ||
      existing.revision !== expectedRevision
    ) {
      return undefined;
    }
    const row = normalizeScimUser({
      ...next,
      createdAt: existing.user.createdAt,
    });
    this.checkUserName(row);
    const revision = randomUUID();
    this.#users.set(id, { user: row, revision });
    this.touch(orgId);
    return { user: normalizeScimUser(row), revision };
  }

  async listByOrganization(
    orgId: string,
    page?: { offset: number; limit: number },
  ): Promise<ScimUserRecord[]> {
    const ordered = this.ofOrg(orgId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(normalizeScimUser);
    return page
      ? ordered.slice(page.offset, page.offset + page.limit)
      : ordered;
  }

  async listInactiveForRecovery(afterId: string | undefined, limit: number) {
    if (this.#scope !== undefined)
      throw new Error(
        "Cannot scan all organizations inside a SCIM transaction",
      );
    return [...this.#users.values()]
      .map(({ user }) => user)
      .filter(
        (user) => !user.active && (afterId === undefined || user.id > afterId),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit)
      .map(({ id, organizationId }) => ({ id, organizationId }));
  }

  forkForTransaction(orgId: string): MemoryStoreFork<MemoryScimUserStore> {
    if (this.#scope !== undefined)
      throw new Error("SCIM transaction cannot be forked");
    const expected = this.#generations.get(orgId) ?? 0n;
    const staged = new MemoryScimUserStore();
    staged.#scope = orgId;
    for (const [id, value] of this.#users) {
      if (value.user.organizationId === orgId) {
        staged.#users.set(id, {
          user: normalizeScimUser(value.user),
          revision: value.revision,
        });
      }
    }
    const validate = () => {
      if ((this.#generations.get(orgId) ?? 0n) !== expected) return false;
      for (const [id, value] of staged.#users) {
        if (value.user.organizationId !== orgId) return false;
        const existing = this.#users.get(id);
        if (existing && existing.user.organizationId !== orgId) return false;
      }
      return true;
    };
    return {
      store: staged,
      validate,
      commit: () => {
        if (!validate()) throw new ConflictError("SCIM transaction is stale");
        if ((staged.#generations.get(orgId) ?? 0n) === 0n) return;
        for (const [id, value] of this.#users) {
          if (value.user.organizationId === orgId) this.#users.delete(id);
        }
        for (const [id, value] of staged.#users) {
          this.#users.set(id, {
            user: normalizeScimUser(value.user),
            revision: value.revision,
          });
        }
        this.touch(orgId);
      },
    };
  }
}
