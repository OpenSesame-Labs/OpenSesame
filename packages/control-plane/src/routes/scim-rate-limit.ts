import type { Organization } from "@opensesame/os-domain";
import type { Context } from "hono";
import type { AppContext } from "../context.js";
import type { Variables } from "../middleware/context.js";
import { updateSecurityMap } from "../repos/durable-map.js";
import { scimError } from "./scim-protocol.js";

export interface ScimMutationWindow {
  count: number;
  expiresAt: Date;
}

interface ScimMutationLimits {
  tenant: number;
  deployment: number;
  windowMs: number;
}

const DEFAULT_LIMITS: ScimMutationLimits = {
  tenant: 600,
  deployment: 6_000,
  windowMs: 60_000,
};
const MAX_WINDOWS = 10_000;
const localRefusals = new WeakMap<AppContext, Map<string, number>>();

function cachedRefusal(ctx: AppContext, key: string, now: number): boolean {
  const cache = localRefusals.get(ctx);
  const expiresAt = cache?.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt > now) return true;
  cache?.delete(key);
  return false;
}

function rememberRefusal(
  ctx: AppContext,
  key: string,
  expiresAt: number,
  now: number,
): void {
  let cache = localRefusals.get(ctx);
  if (!cache) {
    cache = new Map();
    localRefusals.set(ctx, cache);
  }
  if (cache.size >= MAX_WINDOWS) {
    for (const [candidate, expiry] of cache)
      if (expiry <= now) cache.delete(candidate);
  }
  if (cache.size < MAX_WINDOWS) cache.set(key, expiresAt);
}

async function consumeWindow(
  ctx: AppContext,
  key: string,
  limit: number,
  now: number,
  windowMs: number,
  cost: number,
): Promise<boolean> {
  const store = ctx.stores.scimMutationRates;
  if (store instanceof Map && !store.has(key) && store.size >= MAX_WINDOWS) {
    for (const [candidate, row] of store) {
      if (row.expiresAt.getTime() <= now) store.delete(candidate);
    }
    if (store.size >= MAX_WINDOWS) return false;
  }
  let allowed = false;
  let expiresAt = now + windowMs;
  let exhausted = false;
  await updateSecurityMap(store, key, (row) => {
    const current =
      !row || row.expiresAt.getTime() <= now
        ? { count: 0, expiresAt: new Date(now + windowMs) }
        : row;
    expiresAt = current.expiresAt.getTime();
    exhausted = current.count >= limit;
    if (current.count + cost > limit) return current;
    allowed = true;
    return { ...current, count: current.count + cost };
  });
  if (!allowed && exhausted) rememberRefusal(ctx, key, expiresAt, now);
  return allowed;
}

/** Atomic across replicas when the security map is Postgres-backed. */
export async function consumeScimMutation(
  ctx: AppContext,
  organizationId: string,
  limits: ScimMutationLimits = DEFAULT_LIMITS,
  cost = 1,
  scope: "directory" | "admin" = "directory",
): Promise<boolean> {
  if (!Number.isSafeInteger(cost) || cost < 1)
    throw new Error("Invalid SCIM mutation cost");
  const now = ctx.clock().getTime();
  const tenantKey = `${scope}:tenant:${organizationId}`;
  const deploymentKey = `${scope}:deployment`;
  if (
    cachedRefusal(ctx, tenantKey, now) ||
    cachedRefusal(ctx, deploymentKey, now)
  )
    return false;
  return (
    (await consumeWindow(
      ctx,
      tenantKey,
      limits.tenant,
      now,
      limits.windowMs,
      cost,
    )) &&
    (await consumeWindow(
      ctx,
      deploymentKey,
      limits.deployment,
      now,
      limits.windowMs,
      cost,
    ))
  );
}

/**
 * Spend one unit of the tenant and deployment windows for an authenticated
 * mutation, before any body is parsed or durable row is touched.
 */
export async function budgetScimMutation<
  S extends { ctx: AppContext; organization: Organization },
>(c: Context<{ Variables: Variables }>, session: S): Promise<S | Response> {
  if (
    c.req.method !== "GET" &&
    !(await consumeScimMutation(session.ctx, session.organization.id))
  ) {
    c.header("Retry-After", "60");
    return scimError(c, 429, "Provisioning rate limit reached.");
  }
  return session;
}
