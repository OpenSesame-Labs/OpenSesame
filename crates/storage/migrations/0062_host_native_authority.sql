-- Opaque credentials are indexed only by their digest. User-code digests are
-- keyed and bound to each device code; neither code is stored in cleartext.
-- Agent launches created before this migration remain unbound legacy grants;
-- the first withdrawal for their subject revokes them. New launches capture
-- the current membership authority in the same write transaction.
ALTER TABLE agent_launches ADD COLUMN membership_incarnation TEXT;
ALTER TABLE agent_launches ADD COLUMN authority_revision TEXT;

CREATE TABLE host_native_security_binding (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  pepper_fingerprint TEXT NOT NULL,
  resource TEXT NOT NULL
);

CREATE TABLE host_device_codes (
  device_digest TEXT PRIMARY KEY,
  user_code_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_json TEXT,
  organization_id TEXT,
  principal_id TEXT,
  membership_incarnation TEXT,
  authority_revision TEXT,
  CHECK ((membership_incarnation IS NULL) = (authority_revision IS NULL))
);
CREATE INDEX host_device_codes_expiry ON host_device_codes (expires_at);
CREATE INDEX host_device_codes_subject ON host_device_codes (organization_id, principal_id);

CREATE TABLE host_device_approval_failures (attempted_at INTEGER NOT NULL);
CREATE INDEX host_device_approval_failures_time ON host_device_approval_failures (attempted_at);

CREATE TABLE host_native_sessions (
  session_digest TEXT PRIMARY KEY,
  claims_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  organization_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  membership_incarnation TEXT,
  authority_revision TEXT,
  local_session INTEGER NOT NULL CHECK (local_session IN (0, 1)),
  CHECK ((membership_incarnation IS NULL) = (authority_revision IS NULL))
);
CREATE INDEX host_native_sessions_expiry ON host_native_sessions (expires_at);
CREATE INDEX host_native_sessions_subject ON host_native_sessions (organization_id, principal_id);

CREATE TABLE host_membership_current (
  organization_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  membership_incarnation TEXT NOT NULL,
  authority_revision TEXT NOT NULL,
  PRIMARY KEY (organization_id, principal_id)
);
