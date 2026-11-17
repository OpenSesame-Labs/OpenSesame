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
