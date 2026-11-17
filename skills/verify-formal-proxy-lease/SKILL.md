---
name: verify-formal-proxy-lease
description: "Check that vault tomb destroy waits until every open lease is gone and stale releases never drop a newer generation. Use when changing vault-shared-locks, session lease commit, or password-agent leases."
---

# Verify vault open lease and proxy custody

Tomb destroy must wait until every tab’s open lease is gone. A release from an older lease generation must not reduce the live open count after the generation moves on.

If that broke, one tab could still hold the vault while another destroyed the tomb, or a stale `release()` from a forgotten test process could let destroy run while a new unlock still counted as open.

The check is a finite TLA+ model of `acquireOpenLease`, `releaseCount`, and `forgetOpenLeasesForTest`, run with `/statechart`. Charts use `formal-verification`. Password-agent `claimLease` / `authorizeLease` are inventoried for a follow-on model in the same skill directory scope.

## Rerun

```bash
OUT="$(mktemp -d)" && statechart spec/formal-verification/open-vault-lease/OpenVaultLease.tla --view spec/formal-verification/open-vault-lease/OpenVaultLease.view.mjs --config spec/formal-verification/open-vault-lease/OpenVaultLease.cfg --out "$OUT/chart" && npm install pele@1.9.0 --prefix "$HOME/pele-render" && NODE_PATH="$HOME/pele-render/node_modules" node skills/formal-verification/scripts/render-pele-chart.mjs --mmd "$OUT/chart/chart.mmd" --out "$OUT/rendered" --mode both --png
```

Committed config bounds: `MaxLive = 3`, `MaxStale = 3`, `MaxGen = 3` (52 states at last sync).

## Coverage

| File | What the model follows |
| --- | --- |
| `vault-shared-locks.ts` | `acquireOpenLease`, `releaseCount`, `forgetOpenLeasesForTest`, `withExclusiveOpenLease` |
| `store.ts` | `#acquireSessionLease`, `#commitSessionLease`, `#releaseSessionLease` |
| `password-agent/lease.ts` | (inventoried; model next) `authorizeLease`, `claimLease` |

Sync commit: set when this skill lands.

Replay test: `packages/app-core/src/lib/vault/open-vault-lease-formal.replay.test.ts`.

Do not weaken `TypeOK` or `CountMatchesLive`. A TLC failure is a finding in the code or a model drift; change product code only after a red replay test at the boundary users or destroy paths observe.