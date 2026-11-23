import type { ScimUserStore } from "./capacity-admission.js";
import type { Database } from "./repos/postgres.js";
import type { ScimAdminLimits, ScimListPage } from "./scim-admin-limits.js";
import {
  createMemoryScimTokenStore,
  createPostgresScimTokenStore,
} from "./scim-token-store.js";
import type { ScimUserLimits } from "./scim-user-limits.js";
import { MemoryScimUserStore } from "./scim-users-memory.js";
import { PostgresScimUserStore } from "./scim-users-postgres.js";

/**
 * A SCIM 2.0 provisioned user (ADR 0056).
 *
 * No principal is minted at provision time: the row is the organization's
 * answer to "may this subject join?" when a sign-in eventually arrives.
 * `raw` keeps the attributes the IdP sent — SCIM's leniency norm is to accept
 * and echo what we do not model.
 */
export type {
  ScimUserRecord,
  ScimUserStore,
  VersionedScimUser,
} from "./capacity-admission.js";

export interface ScimTokenRecord {
  id: string;
  organizationId: string;
  createdAt: Date;
  revokedAt?: Date;
}

/**
 * Org-scoped provisioning tokens. Only the hash is ever stored — the plaintext
 * `sct_` value exists exactly once, in the mint response.
 */
export interface ScimTokenStore {
  mint(orgId: string, hash: string): Promise<{ id: string }>;
  /** True when a live (unrevoked) token of this org has this hash. */
  verify(orgId: string, hash: string): Promise<boolean>;
  revoke(orgId: string, id: string): Promise<boolean>;
  /** Owner surface: token ids and lifecycle stamps, never hashes. */
  list(orgId: string, page?: ScimListPage): Promise<ScimTokenRecord[]>;
  count(orgId: string): Promise<number>;
  /** Remove retained metadata only after its credential has been revoked. */
  purgeRevoked(orgId: string, id: string): Promise<boolean>;
}

export interface ScimStores {
  users: ScimUserStore;
  tokens: ScimTokenStore;
}

/**
 * `options` lowers the hard per-tenant and deployment-wide user ceilings
 * (`scim-user-limits.ts`) for smaller deployments and tests.
 */
export function createMemoryScimStores(
  options?: Partial<ScimUserLimits>,
  adminLimits?: Partial<ScimAdminLimits>,
): ScimStores {
  return {
    users: new MemoryScimUserStore(options),
    tokens: createMemoryScimTokenStore(adminLimits),
  };
}

export function createPostgresScimStores(
  db: Database,
  options?: Partial<ScimUserLimits>,
  adminLimits?: Partial<ScimAdminLimits>,
): ScimStores {
  return {
    users: new PostgresScimUserStore(db, options),
    tokens: createPostgresScimTokenStore(db, adminLimits),
  };
}
