# Security audit compendium — 2026-08-07

This compendium preserves the original point-in-time audit reports from 2026-08-07. Each section names its original repository path; the individual commits remain available in Git history.


---

## Original report: `2026-08-07-aauth-claim-poll.md`

# Security audit — AAuth helpers + agent claim poll — 2026-08-07

Branch: `chore/audit-tick24`

## Scanners

| Check | Result |
|------|--------|
| cve-lite / clippy / semgrep / battle-test | CLEAN |
| Residual review | Experimental AAuth mappers unauthenticated when enabled; agent claim poll only needed claim id |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | `/experimental/aauth/v1/map/*`, mission/scope open when flag set | Require session or operator bearer |
| Medium | `POST /api/v1/agent-claims/{id}/poll` revealed state with id alone | Require `claim_token` body, verify hash |
| Low | APIs lacked Permissions-Policy | Deny camera/mic/geo/payment/usb on Identity + Host headers |

## Gate

```bash
cargo +1.88.0 clippy -p opensesame-gateway -p opensesame-host-core -- -D warnings
npm run test -w @opensesame/control-plane
```

---

## Original report: `2026-08-07-ast-grep-popup.md`

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

---

## Original report: `2026-08-07-ast-grep.md`

# Security audit — ast-grep loop — 2026-08-07

Branch: `chore/security-ast-grep-loop`

Tool: **ast-grep** (structural SAST). Not used in prior loops (gitleaks, cargo-deny, npm audit, Semgrep, cve-lite).

## Scanners

| Check | Result |
|------|--------|
| `npm run audit:ast-grep` | CLEAN |
| Rules | `tools/security/ast-grep-rules.yml` (SQL format, shell -c, Math.random, eval, innerHTML, localStorage, exec) |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| High | DPoP `jti` fell back to `Math.random()` when `randomUUID` missing | `randomJti()` via `randomUUID` / `getRandomValues` only |
| Medium | Sealed sync persisted to `localStorage` (XSS-exfiltrable) | OPFS primary; in-memory `Map` fallback — never web storage |
| Low | OpenBao `use_credential` Result ignored (`let _ =`) | Log warn on failure |
| Build | Accidental `const mut store` in sync_push | Restored `let mut store` |

## Gate

```bash
npm run audit:ast-grep
```

---

## Original report: `2026-08-07-b.md`

# Security audit — 2026-08-07 (pass B)

Branch: `chore/security-audit-20260807-b`

## Scanner results

| Tool | Result |
|------|--------|
| gitleaks | Clean |
| cargo-deny | OK |
| npm audit | Clean (0 vulns) |
| Semgrep (auth paths + MCP) | 0 findings |
| Dependabot open critical/high/medium | 0 |

## Findings addressed this pass

| Severity | Finding | Fix |
|----------|---------|-----|
| High | Console/mobile MFA embedded `OPENSESAME_OPERATOR_TOKEN` / `opensesame-dev-operator` in the browser bundle | Identity `POST /v1/device/approve` (requirePrincipal) proxies to Host with **server-side** operator token; SPAs call Identity only |
| Medium | Operator token compared with `==` (timing) | Constant-time compare on gateway + daemon |
| Medium | Unauthenticated receipt get/verify + session count | Require session or operator |
| Medium | Daemon `list_sessions` / `introspect_capability` open | Require operator token |
| High (prod config) | Production Identity could proxy without operator token | `assertSecureConfig` requires `OPENSESAME_OPERATOR_TOKEN` when `isProduction` |

## Residual

- `POST /api/v1/agent-identities` remains intentionally unauthenticated (agent starts claim; returns one-time `claim_token`). Consider rate limits / PoP later.
- Claim poll/present by token remains intentional for the claim ceremony.

---

## Original report: `2026-08-07-cargo-audit.md`

# Security audit — cargo-audit loop — 2026-08-07

Branch: `chore/audit-cargo-audit-gate`

Tool: **cargo-audit** (RustSec) via `npm run audit:cargo-audit` / `scripts/audit/cargo-audit-gate.sh`.

## Scanners

| Check | Result |
|------|--------|
| `npm run audit:cargo-audit` (pre-fix; missing gate script) | FAIL (script absent; package.json already pointed at it) |
| `cargo +1.88.0 audit` (raw, no ignore) | FAIL — `RUSTSEC-2023-0071` (`rsa@0.9.10`) |
| `npm run audit:cargo-audit` (post-fix + `.cargo/audit.toml`) | CLEAN |
| `cargo deny check advisories` | ok |

## Findings

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium (RUSTSEC-2023-0071) | Marvin Attack timing sidechannel in `rsa@0.9.10` — **no patched release** | Documented ignore in `.cargo/audit.toml` (same advisory already ignored in `osv-scanner.toml`). Not on JWT/DPoP path (`aws_lc_rs`). |
| Process | `audit:cargo-audit` npm script existed without `scripts/audit/cargo-audit-gate.sh` | Added gate script (toolchain default `1.88.0` matching `rust-toolchain.toml`) |

## Residual (tracked)

- Revisit ignore when `sqlx` drops `rsa` or RustCrypto ships a constant-time fix. sqlx 0.9 requires Rust ≥ 1.94; workspace pins 1.94.1.
- Do not remove the ignore without a lockfile re-check.

## Gate

```bash
npm run audit:cargo-audit
```

---

## Original report: `2026-08-07-claim-verify-xss.md`

# Security audit — claim verify HTML + API headers — 2026-08-07

Branch: `chore/audit-tick19`

## Scanners

| Check | Result |
|------|--------|
| cargo-audit / gitleaks / cargo-deny | CLEAN |
| Residual review | `/v1/claims/:id/verify` interpolated path into HTML; JSON APIs lacked baseline headers |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Claim verify page echoed `:id` (and claim state) into HTML | `escapeHtml` before interpolation |
| Low | Identity API responses had no nosniff / frame / referrer / HSTS | `apiSecurityHeaders` on all Hono routes; HSTS when `publicUrl` is https |

## Gate

```bash
npm run test -w @opensesame/control-plane
```

---

## Original report: `2026-08-07-clippy-semgrep.md`

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

---

## Original report: `2026-08-07-clippy.md`

# Security audit — cargo clippy loop — 2026-08-07

Branch: `chore/security-clippy-loop`

Tool: **cargo clippy** (`--workspace --all-targets -- -D warnings`, same as CI). Not used as a repair-loop driver in prior passes (gitleaks, cargo-deny, npm audit, Semgrep, cve-lite, ast-grep).

## Scanners

| Check | Result |
|------|--------|
| `npm run audit:clippy` / `scripts/audit/clippy-gate.sh` | CLEAN |
| `cargo clippy --workspace --all-targets -- -D warnings` | CLEAN |

## Findings fixed

| Lint | Location | Fix |
|------|----------|-----|
| `too_many_arguments` | `PlaceholderPlacement::assert_allowed` | Introduced `PlaceholderRequestView` |
| `too_many_arguments` | `substitute_placeholder` | Introduced `SubstitutePlaceholderRequest` |
| `too_many_arguments` | broker `finish_receipt` | Introduced `FinishReceiptParts` |
| `uninlined_format_args` | invocation / openbao | Inlined format args |
| `collapsible_if` / `bool_comparison` | authz | Collapsed conditions / `!flag` |
| `result_map_or_else` | openbao health | `map_err` |
| `derivable_impls` | `WasmGuestPolicy` | `#[derive(Default)]` |
| `mixed_attributes` | opensesame-core | Removed conflicting module docs |
| `single_match` | CLI daemon install | `if let` / `is_ok()` |
| `result_large_err` | gateway/daemon auth helpers | Crate-level allow (axum `Response` Err) |

## Gate

```bash
npm run audit:clippy
```

---

## Original report: `2026-08-07-credential-agent-bind.md`

# Security audit — credential-agent bind fence — 2026-08-07

Branch: `chore/audit-tick11`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / semgrep / clippy / gitleaks / osv / cve-lite | CLEAN |
| Residual review | Legacy `credential-agent` bound TCP without daemon loopback fence |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Deprecated credential-agent could bind non-loopback TCP | Apply `assert_tcp_listen_allowed` (same as daemon) |
| Docs | supply-chain CI note still claimed live Actions security job | Note removal in #26 |

## Gate

```bash
cargo +1.88.0 clippy -p opensesame-credential-agent -- -D warnings
npm run audit:ast-grep
```

---

## Original report: `2026-08-07-cve-lite-daemon-bind.md`

# Security audit — cve-lite + daemon bind — 2026-08-07

Branch: `chore/audit-cve-lite`

## Scanners

| Check | Result |
|------|--------|
| `npm run audit:cve-lite` | CLEAN |
| `npm run audit:clippy` / `audit:ast-grep` / `audit:semgrep` | CLEAN |
| `npm run test:task-access` + `./scripts/test/battle-test.sh` | OK |
| Semgrep MCP (daemon/auth/api-client/sync) | no findings |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium (residual) | Daemon TCP could bind non-loopback; UDS-only mode undocumented/unimplemented | Loopback fence + `OPENSESAME_DAEMON_UDS_ONLY=1` in host-core/daemon |

## Gate

```bash
npm run audit:cve-lite
cargo +1.88.0 test -p opensesame-host-core --lib
```

---

## Original report: `2026-08-07-cve-lite.md`

# Security audit — cve-lite loop — 2026-08-07

Branch: `chore/security-cve-lite-loop`

Tool: **cve-lite** (OSV + override hygiene). Not used in prior loops (those used gitleaks / cargo-deny / npm audit / Semgrep SAST).

## Scanners

| Check | Result |
|------|--------|
| `cve-lite . --fail-on low` (OSV) | 0 findings |
| `cve-lite overrides . --fail-on medium` | 0 findings |
| `npm run audit:cve-lite` | CLEAN |
| On-disk copies below override floors | none |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Critical (OA008) | Override floors not applied — vulnerable copies still on disk (`shell-quote@1.7.3`, `tmp@0.2.5`, `adm-zip@0.5.18`, `uuid@8.3.2`, `playwright@1.53.1`, `esbuild@0.18.20`, `vitest@3.2.4`, `vite@6.3.5`) | Clean reinstall; exact override pins; nested parent overrides (`fx-runner>shell-quote`, `web-ext-run>tmp`, `firefox-profile>adm-zip`) |
| High (OA006) | Range overrides fighting exact-pinned parents | Exact pins + parent nested overrides |
| Medium (PD002) | 19 packages imported in workspace source but invisible to root-only phantom check | Declare matching versions in root `devDependencies` (workspace packages already had them) |

## Gate

```bash
npm run audit:cve-lite
```

---

## Original report: `2026-08-07-gateway-bind-cors.md`

# Security audit — gateway bind + production CORS — 2026-08-07

Branch: `chore/audit-tick15`

## Scanners

| Check | Result |
|------|--------|
| gitleaks / cve-lite / cargo-audit / ast-grep / battle-test | CLEAN |
| Residual review | Gateway TCP lacked daemon-style loopback fence; production CORS allowlist not asserted |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Gateway could bind `0.0.0.0` via `OPENSESAME_LISTEN` without override | `assert_tcp_listen_allowed` on gateway; shared `OPENSESAME_ALLOW_NONLOCAL=1` (daemon alias kept) |
| Medium | Production `assertSecureConfig` did not reject empty/`*` CORS | Fail closed on empty, `*`, or `null` origins when `isProduction` |

## Gate

```bash
cargo +1.88.0 test -p opensesame-host-core --lib
npm run test -w @opensesame/control-plane
```

---

## Original report: `2026-08-07-gateway-cors-headers.md`

# Security audit — Host API CORS + security headers — 2026-08-07

Branch: `chore/audit-tick20`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / semgrep / osv | CLEAN |
| Residual review | Browser console/PWA call Host API (`:8787`) and daemon (`:18790`) with no CORS; no nosniff/frame headers |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Host API had no CORS; Vite apps on `:5173+` cannot use `fetch` against `:8787` | Shared `OPENSESAME_CORS_ORIGINS` allowlist (`*`/`null` rejected; production requires explicit list) |
| Low | Gateway/daemon/callback-edge/credential-agent lacked baseline security headers | `apply_http_security` / `apply_security_headers` in host-core (HSTS when resource/host API is https) |

## Gate

```bash
cargo +1.88.0 test -p opensesame-host-core --lib
cargo +1.88.0 clippy -p opensesame-gateway -p opensesame-daemon -p opensesame-callback-edge -p opensesame-credential-agent -- -D warnings
```

---

## Original report: `2026-08-07-identity-claim-poll.md`

# Security audit — Identity claim get/poll + provider health — 2026-08-07

Branch: `chore/audit-tick25`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / semgrep / cve-lite / clippy / battle-test / task-access | CLEAN |
| Residual review | Identity `GET /v1/claims/{id}` and `/poll` leaked state by id; `/health/providers` exposed backend errors unauthenticated |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Identity claim get/poll revealed state (and `completedByPrincipalId`) with claim id alone | Require `X-Claim-Token` or `Bearer osc_clm_…`; verify digest; sdk-cli + mcp-client updated |
| Low | Gateway `/health/providers` public with OpenFGA/OpenBao error strings | Require operator bearer; live-stack test uses existing operator header |

## Gate

```bash
npm run test -w @opensesame/control-plane
cargo +1.88.0 clippy -p opensesame-gateway -- -D warnings
npm run test -w @opensesame/mcp-client
```

---

## Original report: `2026-08-07-listen-fence-remaining.md`

# Security audit — remaining listen fences — 2026-08-07

Branch: `chore/audit-tick16`

## Scanners

| Check | Result |
|------|--------|
| semgrep / osv / ast-grep | CLEAN |
| Residual review | Control-plane, callback-edge, mock-idp still unbound by loopback policy |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Identity `OPENSESAME_CONTROL_PLANE_HOST=0.0.0.0` accepted | `assertListenHostAllowed` in `assertSecureConfig` |
| Medium | callback-edge default loopback but no fence | host-core `assert_tcp_listen_allowed` |
| Low | mock-upstream-idp could bind non-loopback | same env override (`OPENSESAME_ALLOW_NONLOCAL=1`) |

## Gate

```bash
npm run test -w @opensesame/control-plane
npm run test -w @opensesame/mock-upstream-idp
cargo +1.88.0 clippy -p opensesame-callback-edge -- -D warnings
```

---

## Original report: `2026-08-07-loop-2.md`

# Security audit loop 2 — 2026-08-07

Branch: `chore/security-audit-loop-2`

## Scanners

| Tool | Result |
|------|--------|
| gitleaks | Clean |
| cargo-deny | Clean |
| npm audit | Clean |
| Semgrep (auth surfaces) | 0 findings |
| Dependabot open | 0 |

## Findings fixed this loop

| Severity | Finding | Fix |
|----------|---------|-----|
| High | Device session bound to bootstrap principal, not approved subject; OpenFGA/broker always checked `user:demo` | Session meta uses approved principal; `whoami` / invoke / OpenFGA / broker subject from session (operator → `user:demo`) |
| High | Identity `POST /v1/device/approve` accepted client `principal` override | Always forward authenticated `principalId` |
| Medium | Unbounded provisional session map | Evict expired + capacity 1024 → 429 |
| Medium | Unbounded gateway session / sync blob maps | Session cap 1024; sync blob cap 4096 |
| Low | TOTP verify used non-constant-time `===` | `timingSafeEqual` |
| Low | Claim poll projected real token digests into device-auth helper | Placeholder digests; wire response unchanged |

## Stop condition

Pass-2 after fixes: no remaining medium+ authz/DoS findings in scanned surfaces. Intentional public surfaces unchanged (device authorize/token, discovery/health, agent-identity create, claim present/poll). Demo policy still seeds `user:demo` for local bootstrap.

---

## Original report: `2026-08-07-loop.md`

# Security audit loop — 2026-08-07

Branch: `chore/security-audit-loop`

## Scanners (each pass)

| Tool | Result |
|------|--------|
| gitleaks | Clean |
| cargo-deny | Clean |
| npm audit | Clean |
| Semgrep | 0 findings |
| Dependabot open | 0 |

## Findings fixed this loop

| Severity | Finding | Fix |
|----------|---------|-----|
| High | Sync push could overwrite another session's blob / steal ownership | Reject blobs whose owner session ≠ caller (`rejected_foreign_owner`) |
| Medium | Claim token hash compared with `!=` (timing) | `hash_eq` constant-time digest compare |
| Medium | Unauthenticated claim deny by any principal | Deny requires `creatorPrincipalId ===` caller |
| Medium | MCP `list_connections` / `invoke_l1` / `whoami` omitted session token | Require `OPENSESAME_ACCESS_TOKEN` |
| Medium | Daemon `toolbar/status` unauthenticated | Operator token required |
| Medium | Unbounded agent-claim / device-code maps (DoS) | Evict expired + capacity caps (256 / 512) |
| Low | Identity device proxy accepted credentialed / non-http URLs | Scheme + userinfo validation |
| Low | `live-stack-test.sh` wrote `.cursor/debug-7aa2f5.log` | Removed |

## Stop condition

Pass-3 checklist after fixes reported **CLEAN** for known auth/antipattern classes; scanners remain green. Remaining intentional public surfaces: OAuth device authorize/token, discovery docs, health, agent-identity create (capacity-capped), claim present/poll by design.

---

## Original report: `2026-08-07-mobile-mfa-webauthn.md`

# Security audit — mobile MFA WebAuthn ceremony — 2026-08-07

Branch: `chore/audit-tick17`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / gitleaks / clippy / osv / cve-lite / semgrep | CLEAN |
| Residual review | `@opensesame/mobile-mfa` posted fake passkeys + `Bearer prn_…` |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| High | Mobile MFA register/assert used fabricated credential bytes | Real WebAuthn create/get against `/registration-options` + `/authentication-options` |
| Medium | MFA/device actions used principal-id Bearer fallback | Require session access token |

## Gate

```bash
npm run test -w @opensesame/mobile-mfa typecheck
```

---

## Original report: `2026-08-07-mock-idp-pkce.md`

# Security audit — mock upstream IdP PKCE S256 — 2026-08-07

Branch: `chore/audit-tick22`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / semgrep / cargo-audit | CLEAN |
| Residual review | Mock IdP advertised `plain` PKCE and never checked `code_verifier` |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| High | `/authorize` + `/token` ignored PKCE; discovery listed `plain` | Require `code_challenge_method=S256`; verify SHA-256(`code_verifier`) on token exchange (timing-safe) |

## Gate

```bash
npm run test -w @opensesame/mock-upstream-idp
```

---

## Original report: `2026-08-07-osv-scanner.md`

# Security audit — OSV-Scanner loop — 2026-08-07

Branch: `feat/task-access-model` (workspace at scan time)

Tool: **Google OSV-Scanner v2.5.0** (`npm run audit:osv`). Not used in prior loops (those used gitleaks / cargo-deny / npm audit / Semgrep SAST / cve-lite / ast-grep / clippy). Semgrep MCP supply-chain was attempted first but requires a Semgrep daemon unavailable here.

## Scanners

| Check | Result |
|------|--------|
| `osv-scanner scan source` on `Cargo.lock` + `package-lock.json` (pre-fix) | 2 vulns |
| `npm run audit:osv` (post-fix + `osv-scanner.toml` ignores) | CLEAN |
| `cargo deny check advisories` | ok (did not surface GHSA-h395; not in RustSec DB) |
| `cargo test -p opensesame-proof --lib` | 12 passed |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Moderate (GHSA-h395-gr6q-cpjc / CVE-2026-25537) | `jsonwebtoken@9.3.1` type confusion: malformed `exp`/`nbf` treated like absent → validation bypass | Bump workspace dep to `jsonwebtoken@10.4.0` with `aws_lc_rs` (not `rust_crypto`, which pulls unpatched `rsa`) |
| High (RUSTSEC-2023-0071 / Marvin) | `rsa@0.9.10` timing sidechannel — **no patched release** | Transitive via `sqlx-postgres` only. Documented ignore in `osv-scanner.toml` (OSV may omit it from default results as unimportant/uncalled; keep ignore so a reappearance does not silently reopen the gate). DPoP/JWT uses `aws_lc_rs`, not the `rsa` crate. |

## Follow-ups closed in this loop

1. **DPoP validation config** — `Validation::new(header.alg)` with `validate_exp`/`validate_nbf` off and cleared `required_spec_claims` (proofs use custom `iat` checks).
2. **Gate** — `scripts/audit/osv-scanner-gate.sh` + `npm run audit:osv` (auto-downloads pinned binary into `.tools/bin`).
3. **Tooling matrix** — OSV-Scanner added under “Use now” in `tooling-evaluation.md`.

## Residual (tracked)

- Revisit `RUSTSEC-2023-0071` when `sqlx` drops `rsa` or RustCrypto ships a constant-time fix; do not remove the ignore without a lockfile re-check.
- Prefer keeping `jsonwebtoken` on `aws_lc_rs`; switching to `rust_crypto` would reintroduce `rsa` into the JWT path.

## Gate

```bash
npm run audit:osv
```

---

## Original report: `2026-08-07-pages-localstorage.md`

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

---

## Original report: `2026-08-07-pages-unlock-lockout.md`

# Security audit — Pages unlock lockout — 2026-08-07

Branch: `chore/audit-tick13`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / semgrep / gitleaks / osv / cve-lite / cargo-audit / deny | CLEAN |
| Follow-up on PIN hardening (#32) | No attempt throttle — interactive guessing still easy |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Unlock PIN had no fail lockout | Progressive lockout after 3 fails (2s…15m), persisted via OPFS KV |

## Gate

```bash
npm run test -w @opensesame/pages
```

---

## Original report: `2026-08-07-pages-unlock-pin.md`

# Security audit — Pages vault unlock PIN — 2026-08-07

Branch: `chore/audit-tick12` (post `#31` authority vault)

## Scanners

| Check | Result |
|------|--------|
| ast-grep / semgrep / gitleaks | CLEAN |
| Manual review of `#31` unlock | Unsalted SHA-256 of short PIN in OPFS |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Unlock PIN stored as bare SHA-256 (no salt/KDF; 4-char minimum) | Salted PBKDF2-SHA-256 (210k iters), min 6 chars, timing-safe compare; auto-upgrade legacy digests |

## Gate

```bash
npm run test -w @opensesame/pages
```

---

## Original report: `2026-08-07-provisional-session-id.md`

# Security audit — provisional session id is not a credential — 2026-08-07

Branch: `chore/audit-tick18`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / semgrep / osv | CLEAN |
| Residual review | Cookie + token map treated `ps_…` session ids as authenticators |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| High | `provisionalTokens` aliased session id → session; cookie fallback used the raw session id | Auth accepts only `pst_…` access tokens; stop storing session id as a token |

## Gate

```bash
npm run test -w @opensesame/control-plane
```

---

## Original report: `2026-08-07-sdk-browser-storage.md`

# Security audit — sdk-browser storage default — 2026-08-07

Branch: `chore/audit-tick9`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / clippy / semgrep / gitleaks / task-access | CLEAN (no literal `localStorage.setItem`) |
| Manual review | `@opensesame/sdk-browser` defaulted to `localStorage` via `StorageLike` indirection |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| High | Default browser SDK persisted access/refresh tokens in `localStorage` | Default to `sessionStorage`; never write `refresh_token` to storage |

## Gate

```bash
npm run test -w @opensesame/sdk-browser
```

---

## Original report: `2026-08-07-spa-csp-mock-idp.md`

# Security audit — SPA CSP + mock-idp headers — 2026-08-07

Branch: `chore/audit-tick21`

## Scanners

| Check | Result |
|------|--------|
| cve-lite / clippy / gitleaks | CLEAN |
| Residual review | Vite SPAs had no CSP; mock upstream IdP JSON lacked nosniff/frame headers |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Console / Pages / PWA / MFA / example RPs / extension popup allowed any script/style | Meta CSP: `script-src 'self'`, fonts.googleapis + gstatic, `connect-src` http/https/ws for local APIs + Vite HMR |
| Low | Mock IdP responses had only `cache-control` | nosniff / DENY frame / no-referrer; HSTS when issuer is https |

## Gate

```bash
npm run test -w @opensesame/mock-upstream-idp
```

---

## Original report: `2026-08-07-supply-chain-ci.md`

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

---

## Original report: `2026-08-07-task-api-auth.md`

# Security audit — Host API task routes require auth — 2026-08-07

Branch: `chore/audit-tick23`

## Scanners

| Check | Result |
|------|--------|
| osv / gitleaks / cargo-deny | CLEAN |
| Residual review | `/api/v1/tasks*` had no session/operator check |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| High | Anyone who could reach Host API could start/list/terminate tasks and freeze intents | `require_session_or_operator` on all task routes; task engine moved into `AppState` |
| Process | CLI / mcp-host called tasks without credentials | Attach `Bearer operator:…` from `OPENSESAME_OPERATOR_TOKEN` (CLI already had helper; mcp-host `hostFetch` now injects) |

## Gate

```bash
cargo +1.88.0 clippy -p opensesame-gateway -p opensesame-cli -- -D warnings
npm run test -w @opensesame/mcp-host
```

---

## Original report: `2026-08-07-totp-dev-only.md`

# Security audit — stub TOTP gated for production — 2026-08-07

Branch: `chore/audit-tick14`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / clippy / semgrep / osv / task-access | CLEAN |
| Residual review | `/v1/mfa/totp/*` labeled DEV but available whenever `allowDevDefaults` was false |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | In-memory stub TOTP enroll/verify usable outside allowDevDefaults | Return 403 `totp_dev_only`; prefer passkeys for production MFA |

## Gate

```bash
npm run test -w @opensesame/control-plane
```

---

## Original report: `2026-08-07-webauthn-registration.md`

# Security audit — WebAuthn registration ceremony — 2026-08-07

Branch: `chore/audit-tick10`

## Scanners

| Check | Result |
|------|--------|
| osv / cargo-audit / deny / cve-lite / ast-grep / battle-test | CLEAN |
| Residual review | Passkey **register** accepted raw public keys without attestation/challenge in non-dev |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| High | Production MFA passkey register trusted client-supplied `credentialId`/`publicKey` | Require `RegistrationResponseJSON` verified via SimpleWebAuthn against `/passkey/registration-options` challenge (`attestationType: direct`) |
| Process | Stale CI security-job docs (workflows removed in #26) | Left historical; local `npm run audit:*` checklist remains |

## Gate

```bash
npm run build -w @opensesame/auth-upstream test
npm run test -w @opensesame/control-plane
```

---

## Original report: `2026-08-07.md`

# Security audit — 2026-08-07

Branch history: `chore/security-audit-20260807` → follow-up `chore/fix-remaining-high-critical`

## Scanner results

| Tool | Result |
|------|--------|
| gitleaks (`.gitleaks.toml`) | Clean |
| cargo-deny | Advisories / bans / licenses / sources OK |
| Semgrep `p/rust`, `p/typescript` (auth paths) | 0 findings |
| npm audit | **0 high/critical**. Overrides pin shell-quote, adm-zip, tmp, vite, uuid, playwright, esbuild. Stale `apps/browser-extension/package-lock.json` removed (Dependabot source of critical shell-quote). |

## Findings addressed

| Severity | Finding | Fix |
|----------|---------|-----|
| Critical | `POST /api/v1/device/approve` unauthenticated | Requires `X-OpenSesame-Operator` / `Bearer operator:<token>` |
| Critical | Agent claim self-complete via `claim_token` alone | `claim_complete` requires operator **and** claim token |
| Critical | Dependabot `shell-quote` in extension npm lock | Removed stale `package-lock.json`; npm run override `>=1.9.0`; gitignore npm locks |
| High | `POST /api/v1/admin/authority` open | Operator token required |
| High | `POST /api/v1/intents` / `GET whoami` / connections open | Session or operator required |
| High | Daemon mutating routes open on TCP | Operator token on mint/approve/invoke/revoke |
| High | Passkey assert stub always-on | Production uses `@simplewebauthn/server` + one-time challenge; stub only under `allowDevDefaults` |
| High | L2 guest summary returned real secret | Redact to `[REDACTED]` in substitute_placeholder |
| High | Vite `<=6.4.2` in pwa/mobile-mfa/example apps | Pinned to **6.4.3** |
| High | Dependabot adm-zip / tmp / playwright / shell-quote DoS via extension lock | Lock removed; overrides + `@playwright/test` 1.55.1 |
| Medium | Sync pull not session-scoped | Blobs tagged by session_id on push; pull filters |
| Medium | CORS `*` | Explicit `OPENSESAME_CORS_ORIGINS` allowlist |
| Medium | Provisional cookie missing `Secure` | Set when `publicUrl` is https |
| Medium | Incomplete private IP SSRF block | Add 172.16/12, 100.64/10, link-local IPv6 |
| Medium | Leftover `agent_dbg` → `.cursor/debug-*.log` | Removed from broker/authz/storage/providers |

## Operator token

- Env: `OPENSESAME_OPERATOR_TOKEN`
- Dev default (non-production only): `opensesame-dev-operator`
- Production without env: operator routes deny (empty token)

## Passkeys (production)

1. `POST /v1/mfa/passkey/authentication-options` (authenticated) issues a one-time challenge
2. `POST /v1/mfa/passkey/assert` verifies via SimpleWebAuthn against that challenge
3. Stub length-check verifier is **only** enabled when `allowDevDefaults` (tests/local)

## Residual

- Prefer UDS-only daemon bind in locked-down environments (TCP still gated by operator token)
- Full attestation-verified registration ceremony can replace the current register store-once path when Better Auth passkey plugin is wired end-to-end
