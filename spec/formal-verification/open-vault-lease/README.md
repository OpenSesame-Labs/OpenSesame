# Open vault lease

Cross-tab open serialization in `packages/app-core/src/lib/vault/vault-shared-locks.ts`.

Property in plain language: tomb destruction (exclusive open lock) is only available when no tab counts this tomb as open, and a release from an older lease generation cannot reduce the count after `forgetOpenLeasesForTest` or a generation bump.

Rerun and scratch-break steps live in `verify-formal-proxy-lease`.