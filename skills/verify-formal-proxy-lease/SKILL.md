---
name: verify-formal-proxy-lease
description: "Check that vault tomb destroy waits until every open lease is gone and stale releases never drop a newer generation. Use when changing vault-shared-locks, session lease commit, or password-agent leases."
---

# Verify vault open lease and proxy custody

Tomb destroy must wait until every tab’s open lease is gone. A release from an older lease generation must not reduce the live open count after the generation moves on.

If that broke, one tab could still hold the vault while another destroyed the tomb, or a stale `release()` from a forgotten test process could let destroy run while a new unlock still counted as open.

The check is a finite TLA+ model of `acquireOpenLease`, `releaseCount`, and `forgetOpenLeasesForTest`, run with `/statechart`. Charts use `formal-verification`. Password-agent `claimLease` / `authorizeLease` are inventoried for a follow-on model in the same skill directory scope.

## Rerun

From the repo root. TLC is the pstack `/statechart` skill. Nothing in this repo installs a `statechart` binary. Invoke `/statechart` the way `skills/formal-verification/SKILL.md` describes, then render with the `formal-verification` skill.

```bash
OUT="$(mktemp -d)"
```

Invoke `/statechart` with `spec/formal-verification/open-vault-lease/OpenVaultLease.tla`, `--view spec/formal-verification/open-vault-lease/OpenVaultLease.view.mjs`, `--config spec/formal-verification/open-vault-lease/OpenVaultLease.cfg`, and `--out "$OUT/chart"`. Then:

```bash
npm install pele@1.9.0 --prefix "$HOME/pele-render" && NODE_PATH="$HOME/pele-render/node_modules" node skills/formal-verification/scripts/render-pele-chart.mjs --mmd "$OUT/chart/chart.mmd" --out "$OUT/rendered" --mode both --png
```

Committed config bounds: `MaxLive = 3`, `MaxStale = 6`, `MaxGen = 3` (209 states at last sync). The model includes concurrent tabs (`Acquire` up to `MaxLive`), a crash window split across `BeginReleaseCurrent` / `CompleteReleaseCurrent`, and invariants `DestroyOnlyAtZero`, `NoDestroyWhileCountedOpen`, `NoDestroyWhileReleasing`.

## Coverage

| File | What the model follows |
| --- | --- |
| `vault-shared-locks.ts` | `acquireOpenLease`, `releaseCount`, `forgetOpenLeasesForTest`, `withExclusiveOpenLease` |
| `store.ts` | `#acquireSessionLease`, `#commitSessionLease`, `#releaseSessionLease` |
| `password-agent/lease.ts` | (inventoried; model next) `authorizeLease`, `claimLease` |

Sync commit: `3ec3e6660a6bebd1451e4e2c0663136b02421d4e`

Replay test: `packages/app-core/src/lib/vault/open-vault-lease-formal.replay.test.ts`.

Do not weaken the invariants above. A TLC failure is a finding in the code or model drift; change product code only after a red replay test.

## Scratch break (real code)

Prove the replay test catches a stale `release()`. In a scratch tree only (do not commit):

1. Remove the `if (generation !== leaseGeneration) return;` line in `releaseCount`.
2. Run `npm run test -w @opensesame/app-core -- src/lib/vault/open-vault-lease-formal.replay.test.ts` — expect failure (`withExclusiveOpenLease` incorrectly rejects while the current generation still holds a lease, or resolves after stale release when destroy should still be blocked).
3. Restore the guard; the test passes.

Evidence log: `/opt/cursor/artifacts/proxy-lease-scratch-break.log` (good → red scratch → green revert).