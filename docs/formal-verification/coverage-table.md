# Formal verification coverage

Living record for Phase 2. Update the result column when a model, skill, and signed PR exist.

| Subsystem | Files / functions modeled | Properties (plain) | TLC bounds | Result | PR |
| --- | --- | --- | --- | --- | --- |
| Vault presentation & session | `buildVaultState`; `StoreUnlockSession.activate`, `requireTrusted`, `reset`; `VaultStore.lock`, `#afterPrimaryUnwrap`, create paths | Screen `status` matches open/header; `awaitingSecondStep = pending ∧ ¬open`; no parked key while open (`open ⇒ ¬pending`) | Finite session states in `VaultPresentation.tla` (14 states) | Model + skill on branch; TLC green on `BuggyUnlock=FALSE` | (pending signed stack on #2602) |
| Proxy / open lease & surrogate | `vault-shared-locks.ts` acquire/release/forget/exclusive | `DestroyOnlyAtZero`; stale `release()` preserves count; no destroy during mid-release | `MaxLive=3`, `MaxStale=6`, `MaxGen=3` (~209 states) | Model + replay + scratch break green | #2605 |
| Sync / manifest merge | `planManifestMerge` tombstone map | Trashed items are not updated in place | 2-state sketch | Replay green; no product finding | (pending stack) |
| Autofill gesture & origin | `decideFill` trusted triggers | No fill without extension gesture | 2-state sketch | Replay green; no product finding | (pending stack) |
| Release / promotion | — | — | — | Not done | — |
| CLI daemon session | — | — | — | Not done | — |
| Control plane auth | — | — | — | Not done | — |
| PWA shell vs vault generation | `useShellReady` / `computeShellReady` | No shell before activation or timeout; later gen stays mounted | `MaxGen = 3` (TLC bounded) | Fix + replay + integration green | (pending stack) |
| Onboarding & recovery | — | — | — | Not done | — |