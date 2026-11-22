-- Host scopes the non-nil revision sentinel to the organization, principal,
-- and membership incarnation. Later rows and role changes get fresh UUIDs.
-- The constant avoids a table rewrite when adding the revision.
ALTER TABLE "organization_memberships" ADD COLUMN "authority_revision" uuid DEFAULT '00000000-0000-4000-8000-000000000002' NOT NULL;--> statement-breakpoint
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
