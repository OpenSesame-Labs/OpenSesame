-- A constant default lets PostgreSQL add this column without rewriting every
-- existing membership. The token is scoped to (organization_id, principal_id),
-- so old rows may share the sentinel. The migration runs in one transaction;
-- inserts after it commits use a fresh UUID, including rows recreated with the
-- same public membership fields.
ALTER TABLE "organization_memberships" ADD COLUMN "incarnation" uuid DEFAULT '00000000-0000-0000-0000-000000000000' NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_memberships" ALTER COLUMN "incarnation" SET DEFAULT gen_random_uuid();
