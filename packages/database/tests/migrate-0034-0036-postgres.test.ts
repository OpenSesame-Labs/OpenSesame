import { randomUUID } from "node:crypto";
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
import { PostgresOrganizationMembershipStore } from "../src/repos/organization-membership-postgres.js";
import {
  createPgOwner,
  createRealPostgresContextWithMigrations,
} from "./pg-harness-full.js";

const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);
const legacyIncarnation = "00000000-0000-4000-8000-000000000001";
const legacyRevision = "00000000-0000-4000-8000-000000000002";
const nilUuid = "00000000-0000-0000-0000-000000000000";
const journalAttribute = "urn:opensesame:params:scim:2.0:deprovision-journal";

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
        sql`INSERT INTO principals (id, state, assurance) VALUES ('p1', 'active', 'verified'), ('p2', 'active', 'verified'), ('p3', 'active', 'verified')`,
      );
      await db.execute(
        sql`INSERT INTO organizations (id, slug, display_name, state, created_by) VALUES ('org', 'org', 'Organization', 'active', 'p1'), ('org2', 'org2', 'Other organization', 'active', 'p1')`,
      );
      await db.execute(
        sql`INSERT INTO organization_memberships (organization_id, principal_id, role) VALUES ('org', 'p1', 'owner'), ('org', 'p2', 'member'), ('org2', 'p1', 'member')`,
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
      expect(legacy[0]?.incarnation).toBe(legacyIncarnation);
      const missing = await db.execute<{ groups: string | null }>(
        sql`SELECT to_regclass('public.scim_groups')::text AS groups`,
      );
      expect(missing[0]?.groups).toBeNull();

      // The normal upgrade must not update any preexisting membership row,
      // even when the data-repair migration is reached.
      await db.execute(
        sql.raw(`
        CREATE FUNCTION reject_membership_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'unexpected membership update'; END; $$;
        CREATE TRIGGER no_membership_rewrite BEFORE UPDATE ON organization_memberships
        FOR EACH ROW EXECUTE FUNCTION reject_membership_update();
      `),
      );
      await migrate(db, { migrationsFolder });
      await db.execute(
        sql.raw(`
        DROP TRIGGER no_membership_rewrite ON organization_memberships;
        DROP FUNCTION reject_membership_update();
      `),
      );
      const afterStorage = await db.execute<{ filenode: number }>(
        sql`SELECT pg_relation_filenode('public.organization_memberships') AS filenode`,
      );
      expect(afterStorage[0]?.filenode).toBe(beforeStorage[0]?.filenode);
      const legacyRows = await db.execute<{
        organization_id: string;
        principal_id: string;
        incarnation: string;
        authority_revision: string;
      }>(
        sql`SELECT organization_id, principal_id, incarnation, authority_revision FROM organization_memberships ORDER BY organization_id, principal_id`,
      );
      expect(legacyRows).toEqual([
        {
          organization_id: "org",
          principal_id: "p1",
          incarnation: legacyIncarnation,
          authority_revision: legacyRevision,
        },
        {
          organization_id: "org",
          principal_id: "p2",
          incarnation: legacyIncarnation,
          authority_revision: legacyRevision,
        },
        {
          organization_id: "org2",
          principal_id: "p1",
          incarnation: legacyIncarnation,
          authority_revision: legacyRevision,
        },
      ]);
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
        sql`INSERT INTO organization_memberships (organization_id, principal_id, role) VALUES ('org', 'p3', 'member')`,
      );
      const fresh = await db.execute<{
        incarnation: string;
        authority_revision: string;
      }>(
        sql`SELECT incarnation, authority_revision FROM organization_memberships WHERE principal_id = 'p3'`,
      );
      expect(fresh[0]?.incarnation).not.toBe(legacy[0]?.incarnation);
      expect(fresh[0]?.authority_revision).not.toBe(legacyRevision);

      const memberships = new PostgresOrganizationMembershipStore(db);
      const second = await memberships.findVersioned("org", "p2");
      if (!second) throw new Error("missing upgraded membership");
      const roleChange = {
        id: randomUUID(),
        kind: "change_role",
        role: "admin",
        actorType: "system",
        actorPrincipalId: "directory",
        correlationId: "role-change",
      } as const;
      expect(
        await memberships.beginWithdrawal(
          "org",
          "p2",
          legacyIncarnation,
          legacyRevision,
          roleChange,
        ),
      ).toBe(true);
      const changed = await memberships.completeRoleWithdrawal(
        "org",
        "p2",
        legacyIncarnation,
        roleChange.id,
        "admin",
        new Date(),
      );
      expect(changed?.incarnation).toBe(legacyIncarnation);
      expect(changed?.authorityRevision).not.toBe(legacyRevision);
      expect(
        await memberships.beginWithdrawal(
          "org",
          "p2",
          legacyIncarnation,
          legacyRevision,
          roleChange,
        ),
      ).toBe(false);

      const first = await memberships.findVersioned("org", "p1");
      const otherOrganization = await memberships.findVersioned("org2", "p1");
      if (!first || !otherOrganization)
        throw new Error("missing scoped memberships");
      const removal = {
        id: randomUUID(),
        kind: "remove",
        actorType: "human",
        actorPrincipalId: "p1",
        correlationId: "removal",
      } as const;
      expect(
        await memberships.beginWithdrawal(
          "org",
          "p1",
          legacyIncarnation,
          legacyRevision,
          removal,
        ),
      ).toBe(true);
      expect(
        await memberships.removeIfIncarnation(
          "org",
          "p1",
          legacyIncarnation,
          removal.id,
        ),
      ).toBe(true);
      expect(await memberships.findVersioned("org2", "p1")).toEqual(
        otherOrganization,
      );
      await memberships.upsert(first.membership);
      const replacement = await memberships.findVersioned("org", "p1");
      expect(replacement?.incarnation).not.toBe(legacyIncarnation);
      expect(replacement?.authorityRevision).not.toBe(legacyRevision);
      expect(
        await memberships.removeIfIncarnation("org", "p1", legacyIncarnation),
      ).toBe(false);
      expect(
        await memberships.beginWithdrawal(
          "org",
          "p1",
          legacyIncarnation,
          legacyRevision,
          removal,
        ),
      ).toBe(false);
      expect(await memberships.findVersioned("org", "p1")).toEqual(replacement);
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

it.skipIf(!process.env.DATABASE_URL)(
  "repairs previously installed draft migrations without changing valid tokens or withdrawal intents",
  async () => {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) throw new Error("DATABASE_URL is required");
    const before = copyThrough(33);
    const draft = copyThrough(36);
    // Reproduce the already-applied draft SQL and journal. Drizzle does not
    // rerun an earlier migration when its checked-in SQL is later corrected.
    for (const [file, sentinel] of [
      ["0034_stormy_prima.sql", legacyIncarnation],
      ["0036_calm_the_executioner.sql", legacyRevision],
    ] as const) {
      const path = join(draft, file);
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(sentinel, nilUuid),
      );
    }
    const owner = createPgOwner(() =>
      createRealPostgresContextWithMigrations(url, before),
    );
    try {
      const { db } = await owner.acquire();
      await db.execute(
        sql`INSERT INTO principals (id, state, assurance) VALUES ('p1', 'active', 'verified'), ('p2', 'active', 'verified'), ('p3', 'active', 'verified'), ('p4', 'active', 'verified')`,
      );
      await db.execute(
        sql`INSERT INTO organizations (id, slug, display_name, state, created_by) VALUES ('org', 'org', 'Organization', 'active', 'p1'), ('org2', 'org2', 'Other', 'active', 'p1')`,
      );
      await db.execute(
        sql`INSERT INTO organization_memberships (organization_id, principal_id, role) VALUES ('org', 'p1', 'owner'), ('org', 'p2', 'member'), ('org', 'p3', 'member'), ('org', 'p4', 'member'), ('org2', 'p1', 'owner')`,
      );
      await migrate(db, { migrationsFolder: draft });

      const memberships = new PostgresOrganizationMembershipStore(db);
      const removal = {
        id: randomUUID(),
        kind: "remove",
        actorType: "human",
        actorPrincipalId: "p1",
        correlationId: "draft-withdrawal",
      } as const;
      expect(
        await memberships.beginWithdrawal(
          "org",
          "p1",
          nilUuid,
          nilUuid,
          removal,
        ),
      ).toBe(true);
      const pending = await memberships.findVersioned("org", "p1");
      expect(pending?.withdrawal).toEqual(removal);
      await db.execute(
        sql`UPDATE organization_memberships SET incarnation = gen_random_uuid() WHERE principal_id IN ('p2', 'p4')`,
      );
      await db.execute(
        sql`UPDATE organization_memberships SET incarnation = gen_random_uuid() WHERE organization_id = 'org2' AND principal_id = 'p1'`,
      );
      await db.execute(
        sql`UPDATE organization_memberships SET authority_revision = gen_random_uuid() WHERE principal_id IN ('p3', 'p4')`,
      );
      const mixedIncarnation = await memberships.findVersioned("org", "p2");
      const mixedRevision = await memberships.findVersioned("org", "p3");
      const valid = await memberships.findVersioned("org", "p4");
      if (!mixedIncarnation || !mixedRevision || !valid)
        throw new Error("missing draft memberships");
      const targets = [
        {
          principalId: "p1",
          incarnation: nilUuid,
          completed: false,
          note: "pending",
        },
        { principalId: "p2", incarnation: nilUuid, completed: false },
        { principalId: "p3", incarnation: nilUuid, completed: false },
        { principalId: "missing", incarnation: nilUuid, completed: false },
        { principalId: "p1", incarnation: nilUuid, completed: true },
        { principalId: "p1", incarnation: legacyIncarnation, completed: false },
      ];
      const raw = {
        displayName: "Preserve me",
        [journalAttribute]: { cycle: "cycle", targets, note: "preserved" },
      };
      const otherRaw = {
        [journalAttribute]: {
          cycle: "other",
          targets: [
            { principalId: "p1", incarnation: nilUuid, completed: false },
          ],
        },
      };
      const malformedRaw = {
        [journalAttribute]: { cycle: "malformed", targets: "not an array" },
      };
      await db.execute(
        sql`INSERT INTO scim_users (id, organization_id, user_name, active, raw) VALUES ('repair', 'org', 'repair', false, ${JSON.stringify(raw)}::jsonb), ('other', 'org2', 'other', false, ${JSON.stringify(otherRaw)}::jsonb), ('malformed', 'org', 'malformed', false, ${JSON.stringify(malformedRaw)}::jsonb)`,
      );
      await db.execute(
        sql.raw(`
        CREATE FUNCTION reject_valid_membership_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.principal_id = 'p4' THEN RAISE EXCEPTION 'valid row was updated'; END IF;
          RETURN NEW;
        END; $$;
        CREATE TRIGGER no_valid_membership_rewrite BEFORE UPDATE ON organization_memberships
        FOR EACH ROW EXECUTE FUNCTION reject_valid_membership_update();
        CREATE FUNCTION reject_unrelated_scim_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.id IN ('other', 'malformed') THEN RAISE EXCEPTION 'unrelated SCIM row was updated'; END IF;
          RETURN NEW;
        END; $$;
        CREATE TRIGGER no_unrelated_scim_rewrite BEFORE UPDATE ON scim_users
        FOR EACH ROW EXECUTE FUNCTION reject_unrelated_scim_update();
      `),
      );

      await migrate(db, { migrationsFolder });
      const journalRows = await db.execute<{ id: string; raw: unknown }>(
        sql`SELECT id, raw FROM scim_users ORDER BY id`,
      );
      expect(
        journalRows.map(({ id, raw: value }) => ({ id, raw: value })),
      ).toEqual([
        { id: "malformed", raw: malformedRaw },
        { id: "other", raw: otherRaw },
        {
          id: "repair",
          raw: {
            ...raw,
            [journalAttribute]: {
              ...raw[journalAttribute],
              targets: targets.map((target, index) =>
                index === 0 || index === 2
                  ? { ...target, incarnation: legacyIncarnation }
                  : target,
              ),
            },
          },
        },
      ]);
      expect(await memberships.findVersioned("org", "p1")).toEqual({
        ...pending,
        incarnation: legacyIncarnation,
        authorityRevision: legacyRevision,
      });
      expect(await memberships.findVersioned("org", "p2")).toEqual({
        ...mixedIncarnation,
        authorityRevision: legacyRevision,
      });
      expect(await memberships.findVersioned("org", "p3")).toEqual({
        ...mixedRevision,
        incarnation: legacyIncarnation,
      });
      expect(await memberships.findVersioned("org", "p4")).toEqual(valid);
      expect(
        await memberships.removeIfIncarnation(
          "org",
          "p1",
          legacyIncarnation,
          removal.id,
        ),
      ).toBe(true);
      await migrate(db, { migrationsFolder });
      expect(await memberships.findVersioned("org", "p4")).toEqual(valid);
    } finally {
      try {
        await owner.close();
      } finally {
        rmSync(before, { recursive: true, force: true });
        rmSync(draft, { recursive: true, force: true });
      }
    }
  },
  60_000,
);
