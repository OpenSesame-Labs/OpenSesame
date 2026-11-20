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
import { expect, it } from "vitest";

const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);

function copyThrough(index: number): string {
  const folder = mkdtempSync(join(tmpdir(), `os-migrate-${index}-`));
  cpSync(migrationsFolder, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter(
    (entry: { idx: number }) => entry.idx <= index,
  );
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

it("repairs SCIM objects skipped by an upgrade from migration 0026", async () => {
  const before = copyThrough(26);
  const brokenUpgrade = copyThrough(34);
  const client = new PGlite();
  try {
    await client.waitReady;
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: before });
    await client.exec(`
      INSERT INTO principals (id, state, assurance) VALUES ('p1', 'active', 'verified');
      INSERT INTO organizations (id, slug, display_name, state, created_by)
      VALUES ('org', 'org', 'Organization', 'active', 'p1');
      INSERT INTO scim_users (id, organization_id, user_name, active)
      VALUES ('user', 'org', 'user@example.com', true);
    `);
    await migrate(db, { migrationsFolder: brokenUpgrade });
    const missing = await client.query<{
      groups: string | null;
      mappings: string | null;
    }>(
      "SELECT to_regclass('public.scim_groups')::text AS groups, to_regclass('public.scim_group_role_mappings')::text AS mappings",
    );
    expect(missing.rows[0]).toEqual({ groups: null, mappings: null });
    const beforeColumn = await client.query<{ name: string }>(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'oauth_clients' AND column_name = 'token_endpoint_jwks'",
    );
    expect(beforeColumn.rows).toEqual([]);

    await migrate(db, { migrationsFolder });
    const repaired = await client.query<{
      groups: string | null;
      mappings: string | null;
    }>(
      "SELECT to_regclass('public.scim_groups')::text AS groups, to_regclass('public.scim_group_role_mappings')::text AS mappings",
    );
    expect(repaired.rows[0]).toEqual({
      groups: "scim_groups",
      mappings: "scim_group_role_mappings",
    });
    const afterColumn = await client.query<{ name: string }>(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'oauth_clients' AND column_name = 'token_endpoint_jwks'",
    );
    expect(afterColumn.rows).toEqual([{ name: "token_endpoint_jwks" }]);
    const existing = await client.query<{ revision: string }>(
      "SELECT revision FROM scim_users WHERE id = 'user'",
    );
    expect(existing.rows[0]?.revision).toBe(
      "00000000-0000-0000-0000-000000000000",
    );
    await client.exec(
      "INSERT INTO scim_groups (id, organization_id, display_name) VALUES ('group', 'org', 'Group')",
    );
    await expect(
      client.exec(
        "INSERT INTO scim_groups (id, organization_id, display_name) VALUES ('bad', 'missing', 'Group')",
      ),
    ).rejects.toThrow();
    await migrate(db, { migrationsFolder });
  } finally {
    try {
      await client.close();
    } finally {
      rmSync(before, { recursive: true, force: true });
      rmSync(brokenUpgrade, { recursive: true, force: true });
    }
  }
}, 60_000);
