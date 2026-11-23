-- A constant default lets PostgreSQL add this column without rewriting every
-- existing membership. The token is scoped to (organization_id, principal_id),
-- so old rows may share the sentinel. The migration runs in one transaction;
-- inserts after it commits use a fresh UUID, including rows recreated with the
-- same public membership fields. The sentinel must be a non-nil UUID because
-- Host refuses nil membership tokens.
ALTER TABLE "organization_memberships" ADD COLUMN "incarnation" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_memberships" ALTER COLUMN "incarnation" SET DEFAULT gen_random_uuid();
