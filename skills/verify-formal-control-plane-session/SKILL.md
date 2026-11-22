---
name: verify-formal-control-plane-session
description: "Check revoked provisional sessions never resolve. Use when changing resolveProvisionalSession or session revoke."
---

# Verify control plane session monotone

`resolveProvisionalSession` returns undefined when `revokedAt` is set or the lease expired.

Replay: `packages/control-plane/src/middleware/auth-formal.replay.test.ts`.

Model: `spec/formal-verification/control-plane-session/ControlPlaneSession.tla` (`NoZombieSession` covers revoke and expiry).

**Property:** `resolveProvisionalSession` never returns a session after `revokedAt` is set or the lease expires.

**Harm:** A revoked provisional session could still authenticate middleware and widen authority.

**Scratch-break:** `node scripts/formal-scratch-break-four.mjs` (section `control-plane-session`). Log: `/opt/cursor/artifacts/formal-scratch-breaks/control-plane-session.log`.