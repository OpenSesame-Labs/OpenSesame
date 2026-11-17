import { randomUUID } from "node:crypto";
import { TestResourceScope, startEphemeralPostgres } from "@opensesame/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPgOwner, createRealPostgresContext } from "./pg-harness-full.js";

// Explicitly opt in: this suite starts and owns a disposable container; it never
// uses DATABASE_URL or changes roles on a caller-provided server.
describe.runIf(process.env.OPENSESAME_TEST_PG_HARNESS === "1")(
  "Postgres harness cleanup against a disposable server",
  () => {
    const resources = new TestResourceScope();
    let baseUrl: string;
    let admin: ReturnType<typeof postgres>;
    let closing = false;
    let generation = 0;

    function requireOpen(testGeneration?: number) {
      if (
        closing ||
        (testGeneration !== undefined && testGeneration !== generation)
      ) {
        throw new Error("Postgres cleanup fixture is closing");
      }
    }

    beforeAll(async () => {
      try {
        const server = await resources.acquire(startEphemeralPostgres);
        requireOpen();
        const url = new URL(server.databaseUrl);
        if (
          url.protocol !== "postgres:" ||
          !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
          !url.port
        ) {
          throw new Error(
            "disposable Postgres must use an explicit loopback address",
          );
        }
        baseUrl = url.toString();
        admin = postgres(baseUrl, { max: 1, onnotice: () => undefined });
        resources.use({ close: () => admin.end({ timeout: 5 }) });
      } catch (error) {
        try {
          await resources.close();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "fixture setup and cleanup failed",
          );
        }
        throw error;
      }
    }, 90_000);

    afterEach(() => {
      generation += 1;
    });
    afterAll(async () => {
      closing = true;
      await resources.close();
    });

    async function createRole(canCreate: boolean, testGeneration: number) {
      requireOpen(testGeneration);
      const name = `harness_${randomUUID().replaceAll("-", "")}`;
      const password = `fixture_${randomUUID().replaceAll("-", "")}`;
      // Both interpolated values are generated here from UUIDs, not caller input.
      await admin.unsafe(
        `create role "${name}" login password '${password}' ${canCreate ? "createdb" : "nocreatedb"}`,
      );
      requireOpen(testGeneration);
      const url = new URL(baseUrl);
      url.username = name;
      url.password = password;
      return { name, url: url.toString() };
    }

    async function connectionsFor(
      role: string,
      testGeneration: number,
    ): Promise<number> {
      requireOpen(testGeneration);
      const rows = await admin<{ count: number }[]>`
        select count(*)::int as count from pg_stat_activity where usename = ${role}
      `;
      requireOpen(testGeneration);
      return rows[0]?.count ?? -1;
    }

    it("closes the admin connection after a real CREATE DATABASE refusal", async () => {
      const testGeneration = generation;
      const role = await createRole(false, testGeneration);
      requireOpen(testGeneration);
      const attempt = resources.acquire(async () => {
        requireOpen(testGeneration);
        const context = await createRealPostgresContext(role.url);
        return { context, close: () => context.client.close() };
      });
      await expect(attempt).rejects.toMatchObject({ code: "42501" });
      requireOpen(testGeneration);
      expect(await connectionsFor(role.name, testGeneration)).toBe(0);
    });

    it("surfaces a real DROP refusal and still closes both connections", async () => {
      const testGeneration = generation;
      const role = await createRole(true, testGeneration);
      requireOpen(testGeneration);
      const owner = createPgOwner(() => {
        requireOpen(testGeneration);
        return createRealPostgresContext(role.url);
      });
      let expectedCloseError: unknown;
      resources.use({
        close: async () => {
          try {
            await owner.close();
          } catch (error) {
            if (
              !(error instanceof AggregateError) ||
              error.errors.length !== 1 ||
              error.errors[0] !== expectedCloseError
            ) {
              throw error;
            }
          }
        },
      });
      const context = await owner.acquire();
      let databaseName: string | undefined;
      try {
        requireOpen(testGeneration);
        const rows = await context.db.execute<{ name: string }>(
          sql`select current_database() as name`,
        );
        requireOpen(testGeneration);
        const name = rows[0]?.name;
        if (!name || !/^t_[a-f0-9]{32}$/u.test(name)) {
          throw new Error("unexpected temporary database name");
        }
        databaseName = name;
        // The test role can no longer drop the database after ownership moves.
        await admin.unsafe(
          `alter database "${databaseName}" owner to current_user`,
        );
        requireOpen(testGeneration);
        const first = context.client.close();
        expect(context.client.close()).toBe(first);
        let caught: Error;
        try {
          await first;
          throw new Error("expected DROP to fail");
        } catch (cause) {
          if (!(cause instanceof Error))
            throw new Error("expected an Error", { cause });
          caught = cause;
        }
        requireOpen(testGeneration);
        expect(caught).toBeInstanceOf(AggregateError);
        if (!(caught instanceof AggregateError))
          throw new Error("expected aggregate");
        expect(caught.errors).toHaveLength(1);
        expect(caught.errors[0]).toMatchObject({ code: "42501" });
        expectedCloseError = caught;
        await expect(context.client.close()).rejects.toBe(caught);
        requireOpen(testGeneration);
        expect(await connectionsFor(role.name, testGeneration)).toBe(0);
      } finally {
        // This server is disposable; its superuser removes the deliberately
        // orphaned database even if an assertion above fails.
        await context.client.close().catch(() => undefined);
        if (databaseName) {
          await admin.unsafe(
            `drop database if exists "${databaseName}" with (force)`,
          );
        }
      }
    }, 60_000);
  },
);
