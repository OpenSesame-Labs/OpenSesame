# Security audit — ast-grep after UX merge — 2026-08-07

Branch: `chore/audit-tick7` (post `#23` UX polish)

## Scanners

| Check | Result |
|------|--------|
| `npm run audit:ast-grep` (pre-fix) | FAIL — 3× `ts-innerhtml` in extension popup |
| `npm run audit:ast-grep` (post-fix) | CLEAN |
| `npm run audit:semgrep` / `gitleaks` / `cve-lite` | CLEAN |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Extension popup used `innerHTML` for status lines (XSS if host/cursor strings ever attacker-influenced) | `replaceChildren` + `textContent` via `setStatusItems` |

## Gate

```bash
npm run audit:ast-grep
```
