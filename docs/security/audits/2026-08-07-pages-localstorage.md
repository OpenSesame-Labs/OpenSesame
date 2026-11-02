# Security audit — Pages PWA localStorage — 2026-08-07

Branch: `chore/audit-tick8` (post `#25` Pages shell)

## Scanners

| Check | Result |
|------|--------|
| `npm run audit:ast-grep` (pre-fix) | FAIL — `ts-localstorage-set` in `settings.ts` / `queue.ts` |
| `npm run audit:ast-grep` (post-fix) | CLEAN |
| semgrep / gitleaks / cve-lite / osv / cargo-audit | CLEAN |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| High | Operator token + claim/user-code outbox in `localStorage` | OPFS + memory KV; operator token session-only (not persisted) |
| Medium | Offline queue in `localStorage` | Same KV path as settings URLs |

## Gate

```bash
npm run audit:ast-grep
npm run typecheck -w @opensesame/pages test
```
