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
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { expect, it } from "vitest";
import {
  createPgOwner,
  createRealPostgresContextWithMigrations,
} from "./pg-harness-full.js";

const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);

function copyThrough(index: number): string {
  const folder = mkdtempSync(join(tmpdir(), `os-real-migrate-${index}-`));
  cpSync(migrationsFolder, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter(
    (entry: { idx: number }) => entry.idx <= index,
  );
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

it.skipIf(!process.env.DATABASE_URL)(
  "upgrades a PostgreSQL database missing the skipped SCIM migrations",
  async () => {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) throw new Error("DATABASE_URL is required");
    const before = copyThrough(26);
    const brokenUpgrade = copyThrough(34);
    const owner = createPgOwner(() =>
      createRealPostgresContextWithMigrations(url, before),
    );
    try {
      const { db } = await owner.acquire();
      await db.execute(
        sql`INSERT INTO principals (id, state, assurance) VALUES ('p1', 'active', 'verified'), ('p2', 'active', 'verified')`,
      );
      await db.execute(
        sql`INSERT INTO organizations (id, slug, display_name, state, created_by) VALUES ('org', 'org', 'Organization', 'active', 'p1')`,
      );
      await db.execute(
        sql`INSERT INTO organization_memberships (organization_id, principal_id, role) VALUES ('org', 'p1', 'owner')`,
      );
      await db.execute(
        sql`INSERT INTO scim_users (id, organization_id, user_name, active) VALUES ('user', 'org', 'user@example.com', true)`,
      );
      const beforeStorage = await db.execute<{ filenode: number }>(
        sql`SELECT pg_relation_filenode('public.organization_memberships') AS filenode`,
      );
      await migrate(db, { migrationsFolder: brokenUpgrade });
      const legacy = await db.execute<{ incarnation: string }>(
        sql`SELECT incarnation FROM organization_memberships WHERE principal_id = 'p1'`,
      );
      expect(legacy[0]?.incarnation).toBe(
        "00000000-0000-0000-0000-000000000000",
      );
      const missing = await db.execute<{ groups: string | null }>(
        sql`SELECT to_regclass('public.scim_groups')::text AS groups`,
      );
      expect(missing[0]?.groups).toBeNull();

      await migrate(db, { migrationsFolder });
      const afterStorage = await db.execute<{ filenode: number }>(
        sql`SELECT pg_relation_filenode('public.organization_memberships') AS filenode`,
      );
      expect(afterStorage[0]?.filenode).toBe(beforeStorage[0]?.filenode);
      const repaired = await db.execute<{
        groups: string | null;
        mappings: string | null;
      }>(
        sql`SELECT to_regclass('public.scim_groups')::text AS groups, to_regclass('public.scim_group_role_mappings')::text AS mappings`,
      );
      expect(repaired[0]).toMatchObject({
        groups: "scim_groups",
        mappings: "scim_group_role_mappings",
      });
      const columns = await db.execute<{ name: string }>(
        sql`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'oauth_clients' AND column_name = 'token_endpoint_jwks'`,
      );
      expect(columns[0]?.name).toBe("token_endpoint_jwks");
      const oldScim = await db.execute<{ revision: string }>(
        sql`SELECT revision FROM scim_users WHERE id = 'user'`,
      );
      expect(oldScim[0]?.revision).toBe("00000000-0000-0000-0000-000000000000");
      await db.execute(
        sql`UPDATE scim_users SET active = false WHERE id = 'user'`,
      );
      const changedScim = await db.execute<{ revision: string }>(
        sql`SELECT revision FROM scim_users WHERE id = 'user'`,
      );
      expect(changedScim[0]?.revision).not.toBe(oldScim[0]?.revision);
      await db.execute(
        sql`INSERT INTO organization_memberships (organization_id, principal_id, role) VALUES ('org', 'p2', 'member')`,
      );
      const fresh = await db.execute<{
        incarnation: string;
        authority_revision: string;
      }>(
        sql`SELECT incarnation, authority_revision FROM organization_memberships WHERE principal_id = 'p2'`,
      );
      expect(fresh[0]?.incarnation).not.toBe(legacy[0]?.incarnation);
      expect(fresh[0]?.authority_revision).not.toBe(
        "00000000-0000-0000-0000-000000000000",
      );
    } finally {
      try {
        await owner.close();
      } finally {
        rmSync(before, { recursive: true, force: true });
        rmSync(brokenUpgrade, { recursive: true, force: true });
      }
    }
  },
  60_000,
);
