-- A constant default avoids rewriting existing memberships. It is safe because
-- incarnation is compared together with the public membership key; recreated
-- rows receive a fresh UUID after this migration.
ALTER TABLE "organization_memberships" ADD COLUMN "incarnation" uuid DEFAULT '00000000-0000-0000-0000-000000000000' NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_memberships" ALTER COLUMN "incarnation" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
-- A constant default avoids rewriting old SCIM rows. Revisions are compared
-- together with organization_id and id, and every subsequent write replaces it.
ALTER TABLE "scim_users" ADD COLUMN "revision" uuid DEFAULT '00000000-0000-0000-0000-000000000000' NOT NULL;
--> statement-breakpoint
ALTER TABLE "scim_users" ALTER COLUMN "revision" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
-- Writers running an older release, and administrative SQL, may omit the
-- revision column. Rotate it on every update so their changes still invalidate
-- a later compare-and-set from a new replica.
CREATE FUNCTION "public"."opensesame_scim_user_revision"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."revision" := gen_random_uuid();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "scim_users_revision_before_update"
BEFORE UPDATE ON "scim_users"
FOR EACH ROW EXECUTE FUNCTION "public"."opensesame_scim_user_revision"();
--> statement-breakpoint
-- Migrations 0027/0028 have older journal timestamps than 0026. Drizzle can
-- skip them when upgrading an installation already at 0026. Repair those
-- objects without changing historical migration hashes or replaying DDL on
-- installations that received them during a fresh migration.
CREATE TABLE IF NOT EXISTS "scim_group_role_mappings" (
  "organization_id" text NOT NULL,
  "group_id" text NOT NULL,
  "role" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scim_group_role_mappings_pk" PRIMARY KEY ("organization_id", "group_id"),
  CONSTRAINT "scim_group_role_mappings_role_check" CHECK ("role" in ('owner', 'admin', 'member')),
  CONSTRAINT "scim_group_role_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_groups" (
  "id" text NOT NULL,
  "organization_id" text NOT NULL,
  "display_name" text NOT NULL,
  "member_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "scim_groups_pk" PRIMARY KEY ("organization_id", "id"),
  CONSTRAINT "scim_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_groups_organization_id_idx" ON "scim_groups" USING btree ("organization_id");
--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "token_endpoint_jwks" jsonb;
--> statement-breakpoint
-- A key-scoped sentinel avoids a table rewrite when adding the revision.
ALTER TABLE "organization_memberships" ADD COLUMN "authority_revision" uuid DEFAULT '00000000-0000-0000-0000-000000000000' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_memberships" ALTER COLUMN "authority_revision" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD COLUMN "withdrawal_id" uuid;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD COLUMN "withdrawal_kind" text;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD COLUMN "withdrawal_role" text;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD COLUMN "withdrawal_reason" text;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD COLUMN "withdrawal_actor_type" text;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD COLUMN "withdrawal_actor_principal_id" text;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD COLUMN "withdrawal_correlation_id" text;--> statement-breakpoint
CREATE INDEX "organization_memberships_withdrawal_pending_idx" ON "organization_memberships" USING btree ("withdrawal_id") WHERE "organization_memberships"."withdrawal_id" is not null;--> statement-breakpoint
CREATE INDEX "organization_memberships_withdrawal_principal_idx" ON "organization_memberships" USING btree ("principal_id") WHERE "organization_memberships"."withdrawal_id" is not null;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_withdrawal_check" CHECK ((
      "organization_memberships"."withdrawal_id" is null and "organization_memberships"."withdrawal_kind" is null and
      "organization_memberships"."withdrawal_role" is null and "organization_memberships"."withdrawal_reason" is null and "organization_memberships"."withdrawal_actor_type" is null and
      "organization_memberships"."withdrawal_actor_principal_id" is null and
      "organization_memberships"."withdrawal_correlation_id" is null
    ) or (
      "organization_memberships"."withdrawal_id" is not null and "organization_memberships"."withdrawal_kind" is not null and
      "organization_memberships"."withdrawal_actor_type" is not null and "organization_memberships"."withdrawal_actor_type" in ('human','system') and
      "organization_memberships"."withdrawal_actor_principal_id" is not null and "organization_memberships"."withdrawal_correlation_id" is not null and
      (("organization_memberships"."withdrawal_kind" = 'remove' and "organization_memberships"."withdrawal_role" is null and
        ("organization_memberships"."withdrawal_reason" is null or "organization_memberships"."withdrawal_reason" in ('organization_owner_removed','scim_deactivated','ldap_directory_sync'))) or
       ("organization_memberships"."withdrawal_kind" = 'change_role' and "organization_memberships"."withdrawal_role" is not null and
        "organization_memberships"."withdrawal_role" in ('owner','admin','member') and "organization_memberships"."withdrawal_reason" is null))
    ));
--> statement-breakpoint
-- Older writers omit authority_revision and do not know about withdrawals.
-- Rotate when they change a role, and prevent them from changing a role while
-- a withdrawal is pending. Completion clears the intent in the same update.
CREATE FUNCTION "public"."opensesame_membership_authority_revision"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."withdrawal_id" IS NOT NULL AND NEW."withdrawal_id" IS NOT NULL
     AND NEW."role" IS DISTINCT FROM OLD."role" THEN
    RAISE EXCEPTION 'membership withdrawal in progress' USING ERRCODE = '23514';
  END IF;
  IF NEW."role" IS DISTINCT FROM OLD."role"
     AND NEW."authority_revision" = OLD."authority_revision" THEN
    NEW."authority_revision" := gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "organization_memberships_authority_revision_before_update"
BEFORE UPDATE ON "organization_memberships"
FOR EACH ROW EXECUTE FUNCTION "public"."opensesame_membership_authority_revision"();
