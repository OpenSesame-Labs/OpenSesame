-- Bind Identity-backed browser authority to the exact membership incarnation
-- and authority revision that approved it. Local approvals remain unbound.
ALTER TABLE browser_pairings ADD COLUMN membership_incarnation TEXT;
ALTER TABLE browser_pairings ADD COLUMN authority_revision TEXT;
ALTER TABLE browser_clients ADD COLUMN membership_incarnation TEXT;
ALTER TABLE browser_clients ADD COLUMN authority_revision TEXT;
