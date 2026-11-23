-- Bind a pairing decision to the Identity revision known when it was approved.
-- Existing unbound decisions remain legacy and fail closed on withdrawal.
ALTER TABLE browser_pairings ADD COLUMN membership_incarnation TEXT;
ALTER TABLE browser_pairings ADD COLUMN authority_revision TEXT;
