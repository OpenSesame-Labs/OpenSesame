import {
  MemoryOrganizationMembershipStore,
  MemoryScimGroupMappingStore,
  MemoryScimGroupStore,
  MemoryScimUserStore,
  PostgresOrganizationMembershipStore,
  PostgresOrganizationStore,
  PostgresScimUserStore,
  createPostgresOrgFederationStores,
  createPostgresRepositories,
  createPostgresScimStores,
} from "@opensesame/database";
import { sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { DurableMap } from "./durable-map.js";
import { forkMemoryAuditIntents } from "./memory-audit-fork.js";

const memoryTurns = new WeakMap<object, Map<string, Promise<void>>>();

/** Serialize SCIM transitions and directory admission across replicas. */
export async function withScimOrganizationBoundary<T>(
  ctx: AppContext,
  organizationId: string,
  run: (ctx: AppContext) => Promise<T>,
): Promise<T> {
  const { provisionalSessions } = ctx.stores;
  if (!(provisionalSessions instanceof DurableMap))
    return withMemoryScimBoundary(ctx, organizationId, run);
  return withDurableScimBoundary(ctx, organizationId, run);
}

async function withDurableScimBoundary<T>(
  ctx: AppContext,
  organizationId: string,
  run: (ctx: AppContext) => Promise<T>,
): Promise<T> {
  const {
    provisionalSessions,
    organizationMemberships,
    organizationWithdrawalAudits,
    scim,
  } = ctx.stores;
  if (
    !(provisionalSessions instanceof DurableMap) ||
    !(organizationWithdrawalAudits instanceof DurableMap) ||
    !(organizationMemberships instanceof PostgresOrganizationMembershipStore) ||
    !(scim.users instanceof PostgresScimUserStore)
  ) {
    throw new Error(
      "SCIM, membership and session stores must use the same backend",
    );
  }
  return provisionalSessions.transaction(async (db) => {
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('OpenSesame:ScimOrganization'), hashtext(${organizationId}))`,
    );
    // Order directory admission against organization policy updates too.
    await db.execute(
      sql`SELECT id FROM organizations WHERE id = ${organizationId} FOR SHARE`,
    );
    // All reads and writes needed to decide admission or persist its journal
    // use this very transaction. A dead connection cannot leave work running
    // on another connection after its advisory lock has been released.
    const boundScim = createPostgresScimStores(db);
    return run({
      ...ctx,
      repos: {
        ...withoutAuditWrites(ctx.repos),
        externalIdentities: createPostgresRepositories(db).externalIdentities,
        principals: createPostgresRepositories(db).principals,
      },
      stores: {
        ...ctx.stores,
        // Session ids in a legacy recovery snapshot must be read on the same
        // connection as the organization transaction (also required by PGlite).
        provisionalSessions: provisionalSessions.onDatabase(db),
        organizationWithdrawalAudits:
          organizationWithdrawalAudits.onDatabase(db),
        scim: {
          ...boundScim,
          tokens: readOnlyTokens(boundScim.tokens),
        },
        organizations: new PostgresOrganizationStore(db),
        organizationMemberships: new PostgresOrganizationMembershipStore(db),
        // This boundary reads only the LDAP URL, not the sealed bind secret.
        orgFederation: createPostgresOrgFederationStores(db),
      },
    });
  });
}

async function withMemoryScimBoundary<T>(
  ctx: AppContext,
  organizationId: string,
  run: (ctx: AppContext) => Promise<T>,
): Promise<T> {
  const { organizationMemberships, scim } = ctx.stores;
  if (
    !(organizationMemberships instanceof MemoryOrganizationMembershipStore) ||
    !(scim.users instanceof MemoryScimUserStore) ||
    !(scim.groups instanceof MemoryScimGroupStore) ||
    !(scim.mappings instanceof MemoryScimGroupMappingStore) ||
    !(ctx.stores.organizationWithdrawalAudits instanceof Map)
  ) {
    throw new Error(
      "SCIM, membership and session stores must use the same backend",
    );
  }
  let turns = memoryTurns.get(organizationMemberships);
  if (!turns) {
    turns = new Map();
    memoryTurns.set(organizationMemberships, turns);
  }
  const previous = turns.get(organizationId) ?? Promise.resolve();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  turns.set(organizationId, tail);
  await previous;
  try {
    const memberships =
      organizationMemberships.forkForTransaction(organizationId);
    const users = scim.users.forkForTransaction(organizationId);
    const groups = scim.groups.forkForTransaction(organizationId);
    const mappings = scim.mappings.forkForTransaction(organizationId);
    const auditIntents = forkMemoryAuditIntents(
      ctx.stores.organizationWithdrawalAudits,
    );
    const staged = {
      ...ctx,
      repos: withoutAuditWrites(ctx.repos),
      stores: {
        ...ctx.stores,
        organizationMemberships: memberships.store,
        organizationWithdrawalAudits: auditIntents.store,
        scim: {
          ...scim,
          users: users.store,
          groups: groups.store,
          mappings: mappings.store,
          tokens: readOnlyTokens(scim.tokens),
        },
      },
    };
    const result = await run(staged);
    const forks = [memberships, users, groups, mappings, auditIntents];
    if (forks.some((fork) => !fork.validate()))
      throw new Error("SCIM transaction changed concurrently; retry");
    // Validation and every commit execute without yielding, so another
    // in-memory worker cannot observe a partially committed transaction.
    for (const fork of forks) fork.commit();
    return result;
  } finally {
    release();
    if (turns.get(organizationId) === tail) turns.delete(organizationId);
  }
}

function withoutAuditWrites(repos: AppContext["repos"]): AppContext["repos"] {
  return {
    ...repos,
    auditEvents: {
      ...repos.auditEvents,
      append: async () => {
        throw new Error(
          "Audit events must be appended after the SCIM transaction",
        );
      },
    },
  };
}

function readOnlyTokens(
  tokens: AppContext["stores"]["scim"]["tokens"],
): AppContext["stores"]["scim"]["tokens"] {
  const refuse = async (): Promise<never> => {
    throw new Error(
      "SCIM token mutations are not part of the organization transaction",
    );
  };
  return { ...tokens, mint: refuse, revoke: refuse };
}
