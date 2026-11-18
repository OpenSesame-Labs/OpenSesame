# ADR 0226 — Vault relay directory calls require their own service operations

- **Status:** Accepted
- **Date:** 2026-11-17
- **Amends:** [ADR 0181](0181-relay-host-org-vaults-and-join-sync.md), relay service-binding operations.

## Context

The relay's mTLS listener verifies a peer certificate, but the organization
vault directory previously accepted principal and role headers without first
admitting that peer through the installed service bindings. In deployments
without a registration verifier, any certificate trusted by the listener CA
could therefore list or create directory records. Snapshot permissions do not
imply permission to enumerate or create directory records.

## Decision

On an mTLS relay, `GET /v1/org-vaults` requires an admitted `vault_relay`
service caller with operation `vault.relay.directory.list`. `POST` requires
`vault.relay.directory.create`. The existing identity, role and registration
checks still apply after service admission. The relay profile permits those
two operations in addition to its existing snapshot read and write operations;
other purposes and operations remain refused. The local transport's admission
contract is unchanged.

Existing mTLS bindings that need directory access must explicitly add the
appropriate operation. A snapshot-only binding remains valid but cannot list
or create directory records. This deliberate denial requires an operator to
update the binding before upgrading clients that use the directory.

## Verification

Real mTLS tests exercise unbound certificates, snapshot-only and directory-only
bindings, and successful authorized list and create calls. Domain tests verify
that the relay accepts its declared operations and rejects foreign ones.
