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
const sentinel = "00000000-0000-0000-0000-000000000000";

it("upgrades existing memberships and gives later inserts a new incarnation", async () => {
  const before = mkdtempSync(join(tmpdir(), "os-migrate-0034-"));
  const client = new PGlite();
  try {
    cpSync(migrationsFolder, before, { recursive: true });
    const journalPath = join(before, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    journal.entries = journal.entries.filter(
      (entry: { idx: number }) => entry.idx < 34,
    );
    writeFileSync(journalPath, JSON.stringify(journal));
    await client.waitReady;
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: before });
    await client.exec(`
      INSERT INTO principals (id, state, assurance)
      VALUES ('p1', 'active', 'verified'), ('p2', 'active', 'verified');
      INSERT INTO organizations (id, slug, display_name, state, created_by)
      VALUES ('org', 'org', 'Organization', 'active', 'p1');
      INSERT INTO organization_memberships (organization_id, principal_id, role)
      VALUES ('org', 'p1', 'owner'), ('org', 'p2', 'member');
    `);

    await migrate(db, { migrationsFolder });
    const existing = await client.query<{
      principal_id: string;
      incarnation: string;
    }>(
      "SELECT principal_id, incarnation FROM organization_memberships ORDER BY principal_id",
    );
    expect(existing.rows).toEqual([
      { principal_id: "p1", incarnation: sentinel },
      { principal_id: "p2", incarnation: sentinel },
    ]);

    // An old-version writer omits the column, and a recreated row must not
    // receive the token of the membership deleted before it.
    await client.exec(`
      DELETE FROM organization_memberships WHERE organization_id = 'org' AND principal_id = 'p2';
      INSERT INTO organization_memberships (organization_id, principal_id, role)
      VALUES ('org', 'p2', 'member');
    `);
    const replacement = await client.query<{ incarnation: string }>(
      "SELECT incarnation FROM organization_memberships WHERE organization_id = 'org' AND principal_id = 'p2'",
    );
    const token = replacement.rows[0]?.incarnation;
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(token).not.toBe(sentinel);
    await migrate(db, { migrationsFolder });
    const afterRetry = await client.query<{ incarnation: string }>(
      "SELECT incarnation FROM organization_memberships WHERE organization_id = 'org' AND principal_id = 'p2'",
    );
    expect(afterRetry.rows[0]?.incarnation).toBe(token);
  } finally {
    try {
      await client.close();
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  }
}, 60_000);
