-- A withdrawal is a durable fence on one Identity authority revision.  It is
-- retained indefinitely: accepting a delayed approval must never resurrect it.
CREATE TABLE host_membership_withdrawals (
  withdrawal_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  membership_incarnation TEXT NOT NULL,
  authority_revision TEXT NOT NULL,
  UNIQUE (organization_id, principal_id, membership_incarnation, authority_revision)
);
CREATE INDEX host_membership_withdrawals_subject
  ON host_membership_withdrawals (organization_id, principal_id);

CREATE TABLE host_membership_current (
  organization_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  membership_incarnation TEXT NOT NULL,
  authority_revision TEXT NOT NULL,
  PRIMARY KEY (organization_id, principal_id)
);

ALTER TABLE browser_pairings ADD COLUMN identity_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE browser_clients ADD COLUMN identity_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE browser_clients ADD COLUMN membership_incarnation TEXT;
ALTER TABLE browser_clients ADD COLUMN authority_revision TEXT;
ALTER TABLE agent_launches ADD COLUMN membership_incarnation TEXT;
ALTER TABLE agent_launches ADD COLUMN authority_revision TEXT;
