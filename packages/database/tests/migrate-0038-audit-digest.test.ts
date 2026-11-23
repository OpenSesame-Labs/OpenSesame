/**
 * Migration 0038 indexes `audit_events.digest`, which the audit predecessor
 * lookup (`getByDigest`) filters on for every chained append.
 */
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, expect, it } from "vitest";

const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);
const folders: string[] = [];
const clients: PGlite[] = [];

function copyThrough(index: number): string {
  const folder = mkdtempSync(join(tmpdir(), `os-migrate-0038-${index}-`));
  folders.push(folder);
  cpSync(migrationsFolder, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter(
    (entry: { idx: number }) => entry.idx <= index,
  );
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

async function client(): Promise<PGlite> {
  const next = new PGlite();
  clients.push(next);
  await next.waitReady;
  return next;
}

async function digestIndexes(db: PGlite): Promise<string[]> {
  const result = await db.query<{ indexdef: string }>(
    `select indexdef from pg_indexes
     where tablename = 'audit_events' and indexname = 'audit_events_digest_idx'`,
  );
  return result.rows.map((row) => row.indexdef);
}

afterEach(async () => {
  for (const db of clients.splice(0)) await db.close();
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

it("indexes the digest the predecessor lookup filters on", async () => {
  const db = await client();
  await migrate(drizzle(db), { migrationsFolder });
  expect(await digestIndexes(db)).toEqual([
    expect.stringMatching(/USING btree \(digest\)$/u),
  ]);
  await db.exec("set enable_seqscan = off");
  const plan = await db.query<{ "QUERY PLAN": string }>(
    "explain select * from audit_events where digest = 'sha256:x' limit 1",
  );
  expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toMatch(
    /audit_events_digest_idx/u,
  );
});

it("keeps an index an operator already built concurrently", async () => {
  const db = await client();
  await migrate(drizzle(db), { migrationsFolder: copyThrough(37) });
  expect(await digestIndexes(db)).toEqual([]);
  await db.exec(
    `create index concurrently "audit_events_digest_idx" on "audit_events" using btree ("digest")`,
  );
  await migrate(drizzle(db), { migrationsFolder });
  expect(await digestIndexes(db)).toHaveLength(1);
});
