---
name: verify-formal-control-plane-session
description: "Check revoked provisional sessions never resolve. Use when changing resolveProvisionalSession or session revoke."
---

# Verify control plane session monotone

`resolveProvisionalSession` returns undefined when `revokedAt` is set or the lease expired.

Replay: `packages/control-plane/src/middleware/auth-formal.replay.test.ts`.

Model: `spec/formal-verification/control-plane-session/ControlPlaneSession.tla` (`NoZombieSession`).