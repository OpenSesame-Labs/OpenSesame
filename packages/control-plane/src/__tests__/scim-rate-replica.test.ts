import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { consumeScimMutation } from "../routes/scim-rate-limit.js";
import { migratedPGlite, warmMigratedPGlite } from "./migrated-pglite.js";

vi.setConfig({ testTimeout: 60_000 });
beforeAll(warmMigratedPGlite, 60_000);

it("shares atomic mutation windows between Identity replicas", async () => {
  const client = await migratedPGlite();
  try {
    let now = Date.now();
    const options = {
      database: overlapCast(drizzle(client, { schema })),
      clock: () => new Date(now),
      processEnv: {
        ...process.env,
        OPENSESAME_EVENT_KEY: "scim-rate-shared-database-sealing-root",
        OPENSESAME_CLAIM_PEPPER: "scim-rate-shared-database-claim-pepper",
      },
    };
    const first = createControlPlane(options);
    const second = createControlPlane(options);
    await Promise.all([
      first.ctx.systemPrincipalReady,
      second.ctx.systemPrincipalReady,
    ]);
    const limits = { tenant: 2, deployment: 3, windowMs: 60_000 };
    const attempts = await Promise.all([
      consumeScimMutation(first.ctx, "one", limits),
      consumeScimMutation(second.ctx, "one", limits),
      consumeScimMutation(first.ctx, "one", limits),
      consumeScimMutation(second.ctx, "one", limits),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(2);
    expect(await consumeScimMutation(second.ctx, "two", limits)).toBe(true);
    expect(await consumeScimMutation(first.ctx, "two", limits)).toBe(false);
    now += 60_001;
    expect(await consumeScimMutation(second.ctx, "one", limits)).toBe(true);
  } finally {
    await client.close();
  }
});
