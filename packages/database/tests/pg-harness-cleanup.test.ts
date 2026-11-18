import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as schema from "../src/schema/index.js";
import { withPostgresRepos } from "./pg-harness.js";
import {
  type PostgresHarnessDriver,
  createPgOwner,
  createPgliteContext,
  createRealPostgresContext,
} from "./pg-harness-full.js";

const TEST_URL = "postgres://fixture:fixture@127.0.0.1:1/postgres";
const lazyClient = postgres(TEST_URL);
const database = drizzle(lazyClient, { schema });
afterAll(async () => lazyClient.end({ timeout: 1 }));

function causes(error: Error): Error[] {
  if (!(error instanceof AggregateError)) return [error];
  const result: Error[] = [];
  for (const child of error.errors) {
    if (!(child instanceof Error)) throw new Error("expected an Error cause");
    result.push(...causes(child));
  }
  return result;
}

async function rejection<T>(operation: Promise<T>): Promise<Error> {
  try {
    await operation;
  } catch (cause) {
    if (cause instanceof Error) return cause;
    throw new Error("expected an Error rejection", { cause });
  }
  throw new Error("expected a rejection");
}

type Faults = {
  create?: Error;
  client?: Error;
  database?: Error;
  migrate?: Error;
  clientClose?: Error;
  drop?: Error;
  adminClose?: Error;
};

function fakePostgres(faults: Faults = {}) {
  const operations: string[] = [];
  const driver: PostgresHarnessDriver = {
    admin: () => ({
      create: async () => {
        operations.push("create");
        if (faults.create) throw faults.create;
      },
      drop: async () => {
        operations.push("drop");
        if (faults.drop) throw faults.drop;
      },
      close: async () => {
        operations.push("admin.close");
        if (faults.adminClose) throw faults.adminClose;
      },
    }),
    connect: () => {
      if (faults.client) throw faults.client;
      return {
        database: () => {
          if (faults.database) throw faults.database;
          return database;
        },
        close: async () => {
          operations.push("client.close");
          if (faults.clientClose) throw faults.clientClose;
        },
      };
    },
    migrate: async () => {
      operations.push("migrate");
      if (faults.migrate) throw faults.migrate;
    },
  };
  return { operations, driver };
}

describe("database harness resource ownership", () => {
  it("rejects encoded duplicate database overrides before opening any client", async () => {
    const { driver } = fakePostgres();
    const admin = vi.fn(driver.admin);
    const connect = vi.fn(driver.connect);
    await expect(
      createRealPostgresContext(`${TEST_URL}?%64atabase=decoy&database=`, {
        ...driver,
        admin,
        connect,
      }),
    ).rejects.toThrow(/must not override the database/u);
    expect(admin).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
  it("closes the admin client after CREATE fails without attempting a drop", async () => {
    const cause = new Error("create failed");
    const { operations, driver } = fakePostgres({ create: cause });
    await expect(createRealPostgresContext(TEST_URL, driver)).rejects.toBe(
      cause,
    );
    expect(operations).toEqual(["create", "admin.close"]);
  });
  it("preserves CREATE and admin cleanup failures", async () => {
    const create = new Error("create failed");
    const adminClose = new Error("admin close failed");
    const { operations, driver } = fakePostgres({ create, adminClose });
    const caught = await rejection(createRealPostgresContext(TEST_URL, driver));
    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError))
      throw new Error("expected aggregate");
    expect(caught.errors[0]).toBe(create);
    const cleanup = caught.errors[1];
    if (!(cleanup instanceof AggregateError))
      throw new Error("expected cleanup aggregate");
    expect(cleanup.errors).toEqual([adminClose]);
    expect(operations).toEqual(["create", "admin.close"]);
  });
  it("drops the created database if constructing its client fails", async () => {
    const client = new Error("client constructor failed");
    const { operations, driver } = fakePostgres({ client });
    await expect(createRealPostgresContext(TEST_URL, driver)).rejects.toBe(
      client,
    );
    expect(operations).toEqual(["create", "drop", "admin.close"]);
  });
  it("closes the client and drops the database if building its handle fails", async () => {
    const failure = new Error("database handle failed");
    const { operations, driver } = fakePostgres({ database: failure });
    await expect(createRealPostgresContext(TEST_URL, driver)).rejects.toBe(
      failure,
    );
    expect(operations).toEqual([
      "create",
      "client.close",
      "drop",
      "admin.close",
    ]);
  });
  it("retains the migration error while attempting every failing cleanup", async () => {
    const migrate = new Error("migration failed");
    const clientClose = new Error("client close failed");
    const drop = new Error("drop failed");
    const adminClose = new Error("admin close failed");
    const { operations, driver } = fakePostgres({
      migrate,
      clientClose,
      drop,
      adminClose,
    });
    const caught = await rejection(createRealPostgresContext(TEST_URL, driver));
    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError))
      throw new Error("expected aggregate");
    expect(caught.errors[0]).toBe(migrate);
    const cleanup = caught.errors[1];
    if (!(cleanup instanceof AggregateError))
      throw new Error("expected cleanup aggregate");
    expect(cleanup.errors).toEqual([clientClose, drop, adminClose]);
    expect(operations).toEqual([
      "create",
      "migrate",
      "client.close",
      "drop",
      "admin.close",
    ]);
  });
  it("shares one cleanup across concurrent and repeated closes", async () => {
    const { operations, driver } = fakePostgres();
    const context = await createRealPostgresContext(TEST_URL, driver);
    const first = context.client.close();
    const second = context.client.close();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    await context.client.close();
    expect(operations).toEqual([
      "create",
      "migrate",
      "client.close",
      "drop",
      "admin.close",
    ]);
  });

  it("does not start a queued acquisition after close begins", async () => {
    const start = vi.fn();
    const owner = createPgOwner(start);
    const acquisition = owner.acquire();
    const rejected = expect(acquisition).rejects.toThrow("owner is closing");
    const closing = owner.close();
    await rejected;
    await closing;
    expect(start).not.toHaveBeenCalled();
  });

  it("closes a late context without allowing the caller to use it", async () => {
    const { operations, driver } = fakePostgres();
    const context = await createRealPostgresContext(TEST_URL, driver);
    let finish!: (value: typeof context) => void;
    const pending = new Promise<typeof context>((resolve) => {
      finish = resolve;
    });
    let started!: () => void;
    const startedSignal = new Promise<void>((resolve) => {
      started = resolve;
    });
    const owner = createPgOwner(() => {
      started();
      return pending;
    });
    const useContext = vi.fn();
    const acquisition = owner.acquire().then((value) => {
      useContext(value);
    });
    const rejected = expect(acquisition).rejects.toThrow("owner is closing");
    await startedSignal;
    const closing = owner.close();
    expect(operations).toEqual(["create", "migrate"]);
    finish(context);
    await rejected;
    await closing;
    expect(useContext).not.toHaveBeenCalled();
    expect(operations).toEqual([
      "create",
      "migrate",
      "client.close",
      "drop",
      "admin.close",
    ]);
  });

  it("does not run an outbox callback after its owner starts closing", async () => {
    const { operations, driver } = fakePostgres();
    const context = await createRealPostgresContext(TEST_URL, driver);
    let finish!: (value: typeof context) => void;
    const pending = new Promise<typeof context>((resolve) => {
      finish = resolve;
    });
    let started!: () => void;
    const startedSignal = new Promise<void>((resolve) => {
      started = resolve;
    });
    const owner = createPgOwner(() => {
      started();
      return pending;
    });
    const callback = vi.fn();
    const operation = withPostgresRepos(owner, callback);
    const rejected = expect(operation).rejects.toThrow("owner is closing");
    await startedSignal;
    const closing = owner.close();
    finish(context);
    await rejected;
    await closing;
    expect(callback).not.toHaveBeenCalled();
    expect(operations).toEqual([
      "create",
      "migrate",
      "client.close",
      "drop",
      "admin.close",
    ]);
  });

  it("reports late setup and cleanup failures from owner close", async () => {
    const setup = new Error("late setup failed");
    const cleanup = new Error("late cleanup failed");
    const failure = new AggregateError(
      [setup, cleanup],
      "setup and cleanup failed",
    );
    let fail!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    let started!: () => void;
    const startedSignal = new Promise<void>((resolve) => {
      started = resolve;
    });
    const owner = createPgOwner(() => {
      started();
      return pending;
    });
    const acquisition = owner.acquire();
    const rejected = expect(acquisition).rejects.toBe(failure);
    await startedSignal;
    const closing = owner.close();
    const caught = rejection(closing);
    fail(failure);
    await rejected;
    const error = await caught;
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError))
      throw new Error("expected aggregate");
    expect(error.errors).toEqual([failure]);
  });

  it("does not repeat a setup error observed before owner close", async () => {
    const failure = new Error("startup failed");
    const owner = createPgOwner(async () => {
      throw failure;
    });
    await expect(owner.acquire()).rejects.toBe(failure);
    await expect(owner.close()).resolves.toBeUndefined();
  });

  it("surfaces a failed drop and does not retry after the admin is closed", async () => {
    const drop = new Error("drop failed");
    const { operations, driver } = fakePostgres({ drop });
    const context = await createRealPostgresContext(TEST_URL, driver);
    const first = context.client.close();
    const second = context.client.close();
    expect(first).toBe(second);
    const caught = await rejection(first);
    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError))
      throw new Error("expected aggregate");
    expect(caught.errors).toEqual([drop]);
    await expect(context.client.close()).rejects.toBe(caught);
    expect(operations).toEqual([
      "create",
      "migrate",
      "client.close",
      "drop",
      "admin.close",
    ]);
  });

  it("closes PGlite if migration setup fails", async () => {
    const client = new PGlite();
    try {
      await expect(
        createPgliteContext(
          client,
          join(tmpdir(), `missing-migrations-${randomUUID()}`),
        ),
      ).rejects.toThrow();
      expect(client.closed).toBe(true);
    } finally {
      if (!client.closed) await client.close();
    }
  });

  it("preserves callback and cleanup failures together", async () => {
    const client = new PGlite();
    try {
      const context = await createPgliteContext(client);
      const cause = new Error("test callback failed");
      const cleanup = new Error("PGlite close failed");
      const owner = createPgOwner(async () => ({
        ...context,
        client: {
          close: async () => {
            await context.client.close();
            throw cleanup;
          },
        },
      }));
      const caught = await rejection(
        withPostgresRepos(owner, async () => {
          throw cause;
        }),
      );
      expect(caught).toBeInstanceOf(AggregateError);
      expect(causes(caught)).toEqual([cause, cleanup]);
      expect(client.closed).toBe(true);
    } finally {
      if (!client.closed) await client.close();
    }
  });

  it("preserves a callback error while closing the outbox PGlite client", async () => {
    const client = new PGlite();
    try {
      const context = await createPgliteContext(client);
      const cause = new Error("test callback failed");
      const owner = createPgOwner(async () => context);
      await expect(
        withPostgresRepos(owner, async () => {
          throw cause;
        }),
      ).rejects.toBe(cause);
      expect(client.closed).toBe(true);
    } finally {
      if (!client.closed) await client.close();
    }
  });
});
