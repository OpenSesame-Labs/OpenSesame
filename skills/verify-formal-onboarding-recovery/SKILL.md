---
name: verify-formal-onboarding-recovery
description: "Check half-finished enroll never publishes unlocked while second step waits. Use when changing unlock ceremony or buildVaultState."
---

# Verify onboarding / recovery snapshot

`buildVaultState` keeps `awaitingSecondStep = pending && !open`, so status `unlocked` never pairs with a parked key.

Replay: `packages/app-core/src/lib/vault/onboarding-recovery-formal.replay.test.ts`.

Model: `spec/formal-verification/onboarding-recovery/OnboardingRecovery.tla` (`NoUnlockedWhilePending`).

**Property:** The vault screen never shows unlocked while a second step is still pending and the vault is not open.

**Harm:** A person could believe the vault is ready while recovery or second-factor state is still outstanding.

**Scratch-break:** `node scripts/formal-scratch-break-four.mjs` (section `onboarding-recovery`). Log: `/opt/cursor/artifacts/formal-scratch-breaks/onboarding-recovery.log`.