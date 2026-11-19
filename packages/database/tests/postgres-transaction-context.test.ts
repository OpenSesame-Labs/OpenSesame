import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  type Database,
  PostgresRepositories,
  withPostgresTransactionContext,
} from "../src/index.js";

function database(label: string, calls: string[]): Database {
  return overlapCast({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            calls.push(label);
            return [];
          },
        }),
      }),
    }),
  });
}

describe("Postgres repository transaction context", () => {
  it("uses the innermost transaction only for its owning root", async () => {
    const calls: string[] = [];
    const root = database("root", calls);
    const otherRoot = database("other-root", calls);
    const outer = database("outer", calls);
    const inner = database("inner", calls);
    const repositories = new PostgresRepositories(root);
    const otherRepositories = new PostgresRepositories(otherRoot);

    await withPostgresTransactionContext(root, outer, async () => {
      await repositories.principals.getById("prn_outer");
      await otherRepositories.principals.getById("prn_other");
      await withPostgresTransactionContext(root, inner, async () => {
        await repositories.principals.getById("prn_inner");
      });
      await repositories.principals.getById("prn_outer_again");
    });

    expect(calls).toEqual(["outer", "other-root", "inner", "outer"]);
  });

  it("unwinds the transaction context when work throws", async () => {
    const calls: string[] = [];
    const root = database("root", calls);
    const transaction = database("transaction", calls);
    const repositories = new PostgresRepositories(root);

    await expect(
      withPostgresTransactionContext(root, transaction, async () => {
        await repositories.principals.getById("prn_transaction");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await repositories.principals.getById("prn_root");

    expect(calls).toEqual(["transaction", "root"]);
  });
});
