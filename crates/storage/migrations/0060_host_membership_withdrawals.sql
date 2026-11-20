-- Durable, replica-shared fences for Identity membership authority.
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
