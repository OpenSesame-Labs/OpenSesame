# Security audit — clippy / semgrep / ast-grep loop — 2026-08-07

Branch: `chore/audit-clippy-semgrep`

## Scanners

| Check | Result |
|------|--------|
| `npm run audit:clippy` | CLEAN |
| `npm run audit:semgrep` | CLEAN |
| `npm run audit:cve-lite` | CLEAN |
| `npm run test:task-access` | OK |
| `./scripts/test/battle-test.sh` | ALL PASSED |
| `npm run audit:ast-grep` (pre-fix) | FAIL — `ts-eval` on `new Function` in api-client |
| `npm run audit:ast-grep` (post-fix) | CLEAN |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | `new Function(... import('node:crypto'))` in `@opensesame/api-client` DPoP helper | Use `globalThis.crypto.subtle` only (Node 19+ / browsers); fail closed if missing |
| Process | `npm run verify` pinned `cargo +1.94.0` while `rust-toolchain.toml` / scripts use `1.88.0` (slipped into #18) | Restore `+1.88.0` |

## Gate

```bash
npm run audit:clippy && npm run audit:semgrep && npm run audit:ast-grep
```
