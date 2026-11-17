# Formal verification coverage

Living record for Phase 2. Update the result column when a model, skill, and signed PR exist.

| Subsystem | Files / functions modeled | Properties (plain) | TLC bounds | Result | PR |
| --- | --- | --- | --- | --- | --- |
| Vault presentation & session | `buildVaultState`; `StoreUnlockSession.activate`, `requireTrusted`, `reset`; `VaultStore.lock`, `#afterPrimaryUnwrap`, create paths | Screen `status` matches open/header; `awaitingSecondStep = pending ∧ ¬open`; no parked key while open (`open ⇒ ¬pending`) | Finite session states in `VaultPresentation.tla` (14 states) | Model + skill on branch; TLC green on `BuggyUnlock=FALSE` | (pending signed stack on #2602) |
| Proxy / open lease & surrogate | — | — | — | Not done | — |
| Sync / manifest merge | — | — | — | Not done | — |
| Autofill gesture & origin | — | — | — | Not done | — |
| Release / promotion | — | — | — | Not done | — |
| CLI daemon session | — | — | — | Not done | — |
| Control plane auth | — | — | — | Not done | — |
| PWA shell vs vault generation | — | — | — | Not done | — |
| Onboarding & recovery | — | — | — | Not done | — |