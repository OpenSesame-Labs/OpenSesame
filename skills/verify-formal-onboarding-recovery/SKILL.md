---
name: verify-formal-onboarding-recovery
description: "Check half-finished enroll never publishes unlocked while second step waits. Use when changing unlock ceremony or buildVaultState."
---

# Verify onboarding / recovery snapshot

`buildVaultState` keeps `awaitingSecondStep = pending && !open`, so status `unlocked` never pairs with a parked key.

Replay: `packages/app-core/src/lib/vault/onboarding-recovery-formal.replay.test.ts`.

Model: `spec/formal-verification/onboarding-recovery/OnboardingRecovery.tla` (`NoUnlockedWhilePending`).