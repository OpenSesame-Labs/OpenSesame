-- The audit predecessor lookup (`getByDigest`) resolves a chain link by its
-- digest. Without an index every append scans the whole trail. Drizzle applies
-- each migration inside a transaction, so this cannot be CONCURRENTLY; an
-- operator with a large trail can pre-create the same index concurrently, and
-- IF NOT EXISTS then leaves it in place.
CREATE INDEX IF NOT EXISTS "audit_events_digest_idx" ON "audit_events" USING btree ("digest");
