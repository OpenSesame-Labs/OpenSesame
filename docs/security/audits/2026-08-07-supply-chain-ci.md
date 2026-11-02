# Security audit — supply-chain + CI wiring — 2026-08-07

Branch: `chore/audit-supply-chain`

## Scanners (local)

| Check | Result |
|------|--------|
| `npm run audit:gitleaks` | CLEAN |
| `npm run audit:osv` | CLEAN |
| `npm run audit:cargo-audit` | CLEAN |
| `cargo deny check` | ok (duplicate windows_* warnings only) |
| `npm audit --prod` | No known vulnerabilities |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Process | CI ran clippy only; local `npm run audit:*` gates were not enforced on PRs | Added `security` job in `.github/workflows/ci.yml` (later removed with Actions in #26 — run gates locally via checklist) |

## Residual

- Prefer restoring a CI `security` job if/when Actions return; until then `npm run audit:*` + `cargo deny check` are local-only.
- `cve-lite` not on npm (private CLI). Keep on the local re-run checklist.
- cargo-deny duplicate `windows_*` crate noise — non-blocking.

## Gate

```bash
npm run audit:gitleaks && npm run audit:osv && npm run audit:cargo-audit && cargo deny check
```
