import { randomUUID } from "node:crypto";
import { TestResourceScope, startEphemeralPostgres } from "@opensesame/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createPgTestContext } from "./pg-harness-full.js";

// Only a fixture-owned disposable server is used; DATABASE_URL is not trusted.
describe.runIf(process.env.OPENSESAME_TEST_PG_URL_ISOLATION === "1")(
  "Postgres harness URL isolation",
  () => {
    const resources = new TestResourceScope();
    let baseUrl: string;
    let decoyName: string;
    let admin: ReturnType<typeof postgres>;
    let decoy: ReturnType<typeof postgres>;
    let closing = false;
    let generation = 0;

    function requireOpen(testGeneration?: number) {
      if (
        closing ||
        (testGeneration !== undefined && testGeneration !== generation)
      ) {
        throw new Error("Postgres isolation fixture is closing");
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
        decoyName = `decoy_${randomUUID().replaceAll("-", "")}`;
        await resources.acquire(async () => {
          await admin.unsafe(`create database "${decoyName}"`);
          return {
            close: async () => {
              await admin.unsafe(
                `drop database if exists "${decoyName}" with (force)`,
              );
            },
          };
        });
        requireOpen();
        url.pathname = `/${decoyName}`;
        decoy = postgres(url.toString(), { max: 1, onnotice: () => undefined });
        resources.use({ close: () => decoy.end({ timeout: 5 }) });
        await decoy`create table isolation_sentinel (value text not null)`;
        requireOpen();
        await decoy`insert into isolation_sentinel (value) values ('unchanged')`;
        requireOpen();
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
      vi.unstubAllEnvs();
    });
    afterAll(async () => {
      closing = true;
      await resources.close();
    });

    async function databaseNames() {
      return (
        await admin<
          { datname: string }[]
        >`select datname from pg_database order by datname`
      ).map((row) => row.datname);
    }

    async function expectDecoyUntouched(testGeneration: number) {
      requireOpen(testGeneration);
      const rows = await decoy<
        { value: string }[]
      >`select value from isolation_sentinel`;
      requireOpen(testGeneration);
      expect(rows).toEqual([{ value: "unchanged" }]);
      const tables = await decoy<{ tablename: string }[]>`
        select tablename from pg_catalog.pg_tables where schemaname = 'public' order by tablename
      `;
      requireOpen(testGeneration);
      expect(tables.map((row) => row.tablename)).toEqual([
        "isolation_sentinel",
      ]);
    }

    it("rejects a database query override before creating or touching a database", async () => {
      const testGeneration = generation;
      const before = await databaseNames();
      requireOpen(testGeneration);
      const url = new URL(baseUrl);
      url.searchParams.append("database", decoyName);
      vi.stubEnv("DATABASE_URL", url.toString());
      const attempt = resources.acquire(async () => {
        requireOpen(testGeneration);
        const context = await createPgTestContext();
        return { context, close: () => context.client.close() };
      });
      await expect(attempt).rejects.toThrow(/must not override the database/u);
      requireOpen(testGeneration);
      const after = await databaseNames();
      requireOpen(testGeneration);
      expect(after).toEqual(before);
      await expectDecoyUntouched(testGeneration);
    });

    it("uses the newly created database with ordinary connection parameters", async () => {
      const testGeneration = generation;
      const url = new URL(baseUrl);
      url.searchParams.append("application_name", "isolation-regression");
      vi.stubEnv("DATABASE_URL", url.toString());
      const owned = await resources.acquire(async () => {
        requireOpen(testGeneration);
        const context = await createPgTestContext();
        return { context, close: () => context.client.close() };
      });
      requireOpen(testGeneration);
      const rows = await owned.context.db.execute(
        sql`select current_database() as name`,
      );
      requireOpen(testGeneration);
      expect(rows[0]?.name).toMatch(/^t_[a-f0-9]{32}$/u);
      expect(rows[0]?.name).not.toBe(decoyName);
      await expectDecoyUntouched(testGeneration);
    }, 60_000);
  },
);
