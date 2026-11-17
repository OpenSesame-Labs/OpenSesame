import { withTestResources } from "@opensesame/testing";
import type { Repositories } from "../src/repos/interfaces.js";
import type { createPgOwner } from "./pg-harness-full.js";

/**
 * Run the outbox contract with a caller-owned migrated Postgres context. The
 * caller must also close the owner from its test hook if the test times out.
 */
export async function withPostgresRepos<T>(
  owner: ReturnType<typeof createPgOwner>,
  fn: (repos: Repositories) => Promise<T>,
): Promise<T> {
  return withTestResources(async (scope) => {
    scope.use(owner);
    const context = await owner.acquire();
    return fn(context.repos);
  });
}
