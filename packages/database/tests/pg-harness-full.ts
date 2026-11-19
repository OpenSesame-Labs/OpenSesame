import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { overlapCast } from "@opensesame/os-domain";
import { TestResourceScope } from "@opensesame/testing";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import { migrate as migratePostgresJs } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { type Database, PostgresRepositories } from "../src/repos/postgres.js";
import * as schema from "../src/schema/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "drizzle");

export interface PgTestContext {
  repos: PostgresRepositories;
  db: Database;
  /**
   * Closes the connection and, on a real server, drops the context's database.
   * Close is shared across callers; a failed drop is surfaced and is not retried,
   * so a database may need manual cleanup on a long-lived server. A stalled
   * DROP is not bounded and can delay the remaining cleanup indefinitely.
   */
  client: { close(): Promise<void> };
  /** Which engine this context runs on. */
  engine: "pglite" | "postgres-js";
}

/**
 * A fully migrated Postgres wired to the production repositories, with every
 * table/FK/index the repositories rely on.
 *
 * Two engines, one contract. Without `DATABASE_URL` it is an in-process PGlite.
 * With `DATABASE_URL` it is that real server through the production driver
 * (postgres-js), in a database of its own that is dropped afterwards, so the
 * suites are repeatable against a long-lived server and never touch its
 * existing databases. The distinction matters: PGlite binds a JS `Date` that
 * postgres-js cannot, so a raw-SQL fragment with a `Date` parameter passes on
 * one and throws `ERR_INVALID_ARG_TYPE` on the other. Run the suites on both:
 *
 *     npm run test -w @opensesame/database                      # PGlite
 *     DATABASE_URL=postgres://… OPENSESAME_CLAIM_PEPPER=… \
 *       npm run test:postgres -w @opensesame/database           # real server
 *
 * The role in `DATABASE_URL` needs `CREATEDB`.
 */
export async function createPgTestContext(): Promise<PgTestContext> {
  const url = process.env.DATABASE_URL?.trim();
  return url ? createRealPostgresContext(url) : createPgliteContext();
}

/**
 * Own in-flight setup across hook timeouts. Create the owner before the hook,
 * call acquire() within it, and close it in afterAll even if setup timed out.
 * A late context is closed and never returned; late setup failures are reported
 * by close. It cannot cancel or join work already using a returned context,
 * which can race teardown. Stalled starts or cleanup can outlast the runner's
 * hook timeout, and worker termination can interrupt cleanup.
 */
export function createPgOwner(
  start: () => Promise<PgTestContext> = createPgTestContext,
) {
  const scope = new TestResourceScope();
  const lateFailures: unknown[] = [];
  let closing = false;
  let closed: Promise<void> | undefined;
  return {
    acquire: async () => {
      const owned = await scope.acquire(async () => {
        if (closing) throw new Error("database test context owner is closing");
        try {
          const context = await start();
          return { context, close: () => context.client.close() };
        } catch (error) {
          if (closing) lateFailures.push(error);
          throw error;
        }
      });
      if (closing) throw new Error("database test context owner is closing");
      return owned.context;
    },
    close: () => {
      if (!closed) {
        closing = true;
        closed = (async () => {
          let cleanupFailed = false;
          let cleanupError: unknown;
          try {
            await scope.close();
          } catch (error) {
            cleanupFailed = true;
            cleanupError = error;
          }
          if (lateFailures.length) {
            throw new AggregateError(
              cleanupFailed ? [...lateFailures, cleanupError] : lateFailures,
              "late database setup or cleanup failed",
            );
          }
          if (cleanupFailed) throw cleanupError;
        })();
      }
      return closed;
    },
  };
}

async function failAfterCleanup(
  cause: unknown,
  scope: TestResourceScope,
): Promise<never> {
  try {
    await scope.close();
  } catch (cleanupError) {
    throw new AggregateError(
      [cause, cleanupError],
      "database setup and cleanup failed",
    );
  }
  throw cause;
}

export async function createPgliteContext(
  client: PGlite = new PGlite(),
  folder: string = migrationsFolder,
): Promise<PgTestContext> {
  const scope = new TestResourceScope();
  try {
    scope.use(client);
    await client.waitReady;
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: folder });
    // SAFETY: drizzle(PGlite) is the same schema-typed Database as postgres-js;
    // the query-result HKT differs, so TypeScript requires the unknown step.
    const database: Database = overlapCast(db);
    return {
      repos: new PostgresRepositories(database),
      db: database,
      client: { close: () => scope.close() },
      engine: "pglite",
    };
  } catch (error) {
    return failAfterCleanup(error, scope);
  }
}

/** The same server and credentials, another database name. */
function withDatabase(url: string, name: string): string {
  // postgres.js and WHATWG URLs disagree about a raw fragment in the
  // authority. Reject it before either parser can select a different target.
  if (url.includes("#")) {
    throw new Error("DATABASE_URL must not contain a fragment");
  }
  const next = new URL(url);
  if (!["postgres:", "postgresql:"].includes(next.protocol)) {
    throw new Error("DATABASE_URL must use the Postgres URL scheme");
  }
  // postgres.js forwards unknown query keys as startup parameters, which can
  // override the path-derived database (including with an empty value).
  for (const key of next.searchParams.keys()) {
    if (["database", "dbname", "db"].includes(key.toLowerCase())) {
      throw new Error(
        "DATABASE_URL must not override the database in its query",
      );
    }
  }
  next.pathname = `/${name}`;
  return next.toString();
}

/** Narrow, test-only seam for injecting deterministic driver failures. */
export interface PostgresHarnessDriver {
  admin(url: string): {
    create(name: string): Promise<void>;
    drop(name: string): Promise<void>;
    close(): Promise<void>;
  };
  connect(url: string): {
    database(): Database;
    close(): Promise<void>;
  };
  migrate(database: Database): Promise<void>;
}

const realPostgresDriver: PostgresHarnessDriver = {
  admin: (url) => {
    const sql = postgres(url, { max: 1, onnotice: () => undefined });
    return {
      create: async (name) => {
        await sql.unsafe(`create database "${name}"`);
      },
      drop: async (name) => {
        await sql.unsafe(`drop database if exists "${name}" with (force)`);
      },
      close: () => sql.end({ timeout: 5 }),
    };
  },
  connect: (url) => {
    const sql = postgres(url, {
      max: 4,
      prepare: false,
      onnotice: () => undefined,
    });
    return {
      database: () => drizzlePostgresJs(sql, { schema }),
      close: () => sql.end({ timeout: 5 }),
    };
  },
  migrate: (database) => migratePostgresJs(database, { migrationsFolder }),
};

export async function createRealPostgresContext(
  url: string,
  driver: PostgresHarnessDriver = realPostgresDriver,
): Promise<PgTestContext> {
  // A database of its own rather than a schema: the migrations name
  // `"public"."principals"` in their foreign keys, so a second schema would
  // point back at the first context's tables.
  const databaseName = `t_${randomUUID().replaceAll("-", "")}`;
  // Validate before creating a client or issuing CREATE DATABASE.
  const databaseUrl = withDatabase(url, databaseName);
  const scope = new TestResourceScope();
  try {
    const admin = scope.use(driver.admin(url));
    await admin.create(databaseName);
    // Do not drop a database unless CREATE returned successfully: a rejected
    // CREATE could name a database this fixture did not create. If the server
    // created it but the acknowledgement was lost, it may need manual cleanup.
    scope.use({ close: () => admin.drop(databaseName) });
    const connection = scope.use(driver.connect(databaseUrl));
    const database = connection.database();
    await driver.migrate(database);
    return {
      repos: new PostgresRepositories(database),
      db: database,
      engine: "postgres-js",
      client: { close: () => scope.close() },
    };
  } catch (error) {
    return failAfterCleanup(error, scope);
  }
}

/** A disposable real server database migrated through a chosen journal. */
export function createRealPostgresContextWithMigrations(
  url: string,
  folder: string,
): Promise<PgTestContext> {
  return createRealPostgresContext(url, {
    ...realPostgresDriver,
    migrate: (database) =>
      migratePostgresJs(database, { migrationsFolder: folder }),
  });
}
