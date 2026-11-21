-- A single durable owner spends the budget for an invocation. A retry is
-- bound to the same effect and authority before it can reuse a prior receipt.
-- Fingerprints are deployment-keyed, never raw request parameters.
-- Incomplete claims survive restarts: an uncertain invocation is never run
-- again merely because its budget was already decremented.
CREATE TABLE invocation_budget_claims (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  claim_id TEXT NOT NULL UNIQUE,
  delegation_id TEXT,
  budget_key TEXT,
  charged INTEGER NOT NULL CHECK (charged IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key)
);
