# Security audit compendium — 2026-08-17 through 2026-08-31

This compendium preserves the original point-in-time audit reports from late August 2026. Each section names its original repository path; the individual commits remain available in Git history.


---

## Original report: `2026-08-17-deepsec.md`

# Audit — 2026-08-17 — deepsec install + scan + AI process

## What we did

1. Installed [vercel-labs/deepsec](https://github.com/vercel-labs/deepsec) into
   `.deepsec/` (`deepsec@2.3.5`), linked a dedicated Vercel project for AI
   Gateway OIDC, and wrote OpenSesame-specific `INFO.md` +
   `deepsec.config.ts` (priority paths for Host/Identity/auth crates).
2. Ran the free pattern scan: **503 matcher hits across 200 files**.
3. After AI Gateway credits were available, ran AI `process` with
   **`zai/glm-5.2` / Pi / medium thinking** over **all 200 tracked files**.
   Deepsec defaults now use that model.

Earlier AI-route blockers (Claude local proxy, Codex `approval_policy=Never`,
free-tier Gateway 403/429) are documented in git history of this file; they
no longer apply to the completed process pass.

## Pattern scan headline

| Matcher | Hits |
|--------|-----:|
| insecure-crypto | 114 |
| rs-axum-route | 69 |
| secret-in-log | 51 |
| process-env-access | 43 |
| ssrf | 40 |
| crypto-usage | 40 |
| auth-bypass | 24 |
| mcp-tool-handler | 15 |
| xss | 14 |
| open-redirect | 10 |

## AI process headline (2026-08-18)

All 200 files analyzed. **110 open findings** exported to
`.deepsec/findings/` and `.deepsec/data/opensesame/reports/`.

| Severity | Count |
|----------|------:|
| CRITICAL | 0 |
| HIGH | 1 |
| MEDIUM | 64 |
| HIGH_BUG | 4 |
| BUG | 41 |

Gateway cost across process runs (reported by deepsec): roughly **$20.2**
and **~6.5M tokens** (`$0.21 + $2.87 + $4.75 + $3.20 + $0.15 + $4.34 + $3.23 + $1.45`).

### HIGH (1)

- **SSRF without DNS pinning** — `packages/oauth-provider/src/metadata/safe-fetcher.ts`
  (`assertSafeMetadataUrl` checks hostname literals / IP strings only; CIMD
  fetch can still hit private/metadata IPs via DNS). CIMD is off by default
  and the fetcher is not wired into oidc-provider yet.

### HIGH_BUG (4)

- Webhook claim-then-append: event lost if `append_outbox` fails after
  `try_claim_host_kv` (`crates/gateway/src/github_webhook.rs`)
- Lock-order inversion / deadlock in agent-claim (`crates/gateway/src/routes/agents.rs`)
- In-memory pairwise subject store in production
  (`packages/oauth-provider/src/pairwise/store.ts`)
- `completeClaim` drops `ClaimDecision.claimToken`
  (`packages/sdk-browser/src/client.ts`)

## Remediation (2026-08-18)

AI findings were revalidated and patched in-tree. HIGH and HIGH_BUG items
are closed. MEDIUM/BUG items that were real were patched rather than deferred.

### HIGH

- `SafeMetadataFetcher` now DNS-resolves every address (`lookup({ all: true })`),
  refuses if any is private/special, pins the GET to a verified IP with SNI/Host
  of the original name, refuses redirects, caps the body at 64KiB, and requires
  `application/json`.

### HIGH_BUG

- GitHub webhooks claim the HMAC-verified **body digest**, roll back the claim
  if `append_outbox` fails, and reject a malformed signature before DB lookup.
- Agent-claim locks are always `claims` then `claim_user_code_attempts`; poll
  and complete honour `expires_at`; `narrowed_actions` is persisted.
- Production `createOpenSesameProvider` refuses an in-memory pairwise store;
  control-plane wires `createPostgresPairwiseStore` next to the OIDC adapter.
- Browser `completeClaim` sends `claimToken` (body + `x-claim-token`) and
  path-encodes `claimId`. Identity verifies the token when present.

### MEDIUM (selected)

- Correlation ids allowlisted; claim store TTL/capacity prune; claim complete
  ownership on project/agent activation; device-approve `redirect: "error"`
  and generic Host errors; MFA fence increments before verify; mapping-resolve
  uses SHA-256 then `timingSafeEqual`; provisional revoke requires origin for
  cookie; changelog requires `can_configure_integrations` and stamps actor/org
  from the caller; NATS callout ignores self-asserted `project_ids` and strips
  system subjects in release; rotation jobs are org-scoped; TaskBus URLs redact
  userinfo; sync-blob auth before work + body limits; IPv4-mapped IPv6 SSRF in
  SDK CLI/server; production CORS refuses the unset-env dev allowlist;
  callback-edge webhooks require HMAC; health authority/degraded are opaque.
- Daemon proxy: shared HTTP client, hop/`X-Forwarded-*` stripped, `claim_id`
  path-id allowlist, unauthenticated `/health` is `{status,service,tailscale_url}`
  only, request **and** response bodies capped at 2MiB.
- Pages vault: non-extractable CryptoKey, PIN length ≥8 + 1.2M PBKDF2, prefix
  filters, `auth.js` origin-bound authorize links.
- Worker `/health/ready` and `/v1/providers` require operator/worker token;
  probe results cached 10s; outbox drain claims unpublished rows
  (`claim:<deadline>` + `FOR UPDATE SKIP LOCKED`) so two workers cannot double
  publish; process-local drain lock serializes ticks.
- Control-plane: per-principal mutation serialization for quota, idempotency
  inflight lock, claim.create quota, MFA anonymous fingerprint fence + map cap,
  audit chain `timingSafeEqual`.
- Gateway: device authorize capacity under one lock, backup resync rate, sync
  blob caps, changelog per-org ring, TaskBus partition does not drop outbox.
- Packages: `cloneClaim` deep-clones nested decision objects; OIDC memory
  adapter purges secondary indexes on expiry; CLI `emit()` redacts JSON on
  both human and `--json` paths and refreshes expired access tokens; MCP host
  `toolError` uses `forAgent` and Host audience pin; mobile-mfa masks the
  session token; credential-agent recovers poisoned mutexes and binds mint to
  `session_id`; in-memory task store caps at 512 and prunes expired runs.

### PACT coverage

Failure-scenario tests follow [docs/validation/pact.md](../../validation/pact.md)
(Property / Adversarial / Chaos / conTract). Shared helpers live in
`opensesame_host_core::pact` and `@opensesame/testing` (`pact.ts`).

Covered scenarios: exclusive claim vs check-then-set mutant; webhook/backup
TaskBus partition (durable outbox / actor notify survive); claim-before-append
rollback; concurrent org/claim quota and idempotency; MFA/anon rate fence;
outbox exclusive claim + drain partition; OpenAPI 401 on every secured Identity
path; Host device capacity under interleaving; rotation job survives bus down;
sync blobs fail closed without a session; callback-edge HMAC + path fence;
Pages non-extractable vault key / PIN floor / claim tokens off disk; MCP
`forAgent` + Host audience pin; CLI emit redaction. See
[docs/validation/pact.md](../../validation/pact.md) for the coverage matrix.

Scanner hygiene (over-redaction of a field named `code`, pattern-scan SSRF on
build-time Vite URLs) is not a vulnerability and is not tracked as deferred
work.



## How to resume / revalidate

```bash
cd .deepsec
vercel env pull .env.local --environment=development --yes
npm run deepsec revalidate --project-id opensesame
npm run deepsec export --project-id opensesame --format md-dir --out ./findings
npm run deepsec report --project-id opensesame
```

Everyday pattern scan (no AI):

```bash
npm run audit:deepsec
```

## eve agent (Blackbox GLM, no `deepsec process`)

`tools/eve-deepsec` is a standalone eve app: model `zai/glm-5.2` with
`providerOptions.gateway.only: ["blackbox"]`. It runs the pattern scanner and
triages hits itself. It refuses `deepsec process` (that was the paid Pi path).

```bash
cd tools/eve-deepsec && npm install --ignore-workspace
npm run eve:deepsec
```

Requires Node 24+ and Gateway auth. Promo is eve+Blackbox through 2026-08-27;
`glm-5.2-fast` is excluded.

Optional AI process (already complete; reruns skip analyzed files unless
`--reinvestigate`):

```bash
DEEPSEC_PROCESS=1 npm run audit:deepsec
```

## Repo wiring

- `.deepsec/` workspace (config + INFO committed-friendly; secrets gitignored)
- `tools/eve-deepsec/` — eve + Blackbox GLM triage (`npm run eve:deepsec`)
- `scripts/audit/deepsec-gate.sh` + `npm run audit:deepsec`
- Tooling evaluation: pattern gate in “use now”; AI process uses Gateway + `zai/glm-5.2`

---

## Original report: `2026-08-18-deepsec-followup.md`

# DeepSec follow-up and independent security audit (2026-08-18)

## Scope

This follow-up reviewed the prior DeepSec report (110 findings across 200
analyzed files), the remediation commits already present on this branch, all
11 files currently pending DeepSec AI analysis, and the repository security
gates. The fresh local matcher run was
`20260819015523-3bf8279f98c41d17` (532 candidates across 210 files).

No unresolved prior DeepSec finding was found. The report counts shown by
`deepsec status` are historical findings, not a post-remediation rescan result.

## Additional findings fixed

- Repository tools accepted absolute, parent-relative, and symlink-escaped
  paths. All reads and greps now resolve through one canonical repository-root
  confinement check, with traversal and symlink regression coverage.
- The passkey enrollment handoff used `sessionStorage` across
  `127.0.0.1` → `localhost`, where origin isolation drops the flag. The handoff
  now uses a one-shot query flag that is removed from browser history on use.
- Queue identifiers used `Math.random()` as a fallback. They now fail closed to
  the browser's `crypto.randomUUID()` implementation.
- The sealed-store path parser stripped leading `/` before checking whether a
  path was absolute. It now rejects the original absolute path before joining
  it to the store root.
- `async-nats 0.42` pulled vulnerable `rustls-webpki 0.102.8`; `async-nats 0.50`
  removes it. `age 0.11` pulled unmaintained `proc-macro-error2`; `age 0.12.1`
  removes it. OSV and Cargo Audit now report zero vulnerabilities.
- OpenBao and OpenFGA outbound bases now require HTTPS or a typed IPv4/IPv6
  loopback host with no URL userinfo. Regression tests cover IPv6 loopback and
  verify every OpenFGA send is preceded by the guard.
- The DeepSec config contained duplicate model and route keys. The duplicates
  were removed.
- Secret scanning now excludes only documented local runtime state and marks
  individual public/fake fixtures. The working tree has zero gitleaks findings.

Validation failures discovered during the audit were also repaired: PACT test
modules had missing delimiters, changelog tests cleared shared state while
running in parallel, the visual contract depended on live Host state, and the
fuzz runner included ordinary `*.test.ts` files.

## Verification

Clean:

- `npm run test:all`
- `cargo +1.88.0 test --workspace --all-targets`
- `npm run test:security`
- `npm run test:task-access`
- `npm run audit:ast-grep`
- `npm run audit:clippy`
- `npm run audit:semgrep`
- `npm run audit:gitleaks` (working tree; 56 historical matches reduce to nine
  unique public/fake fixtures repeated across commits and generated assets)
- `npm run audit:cve-lite`
- `npm run audit:osv`
- `npm run audit:cargo-audit`
- `FUZZ_SECONDS=1 npm run test:fuzz`

The changed-file Biome gate remains blocked by 236 formatting diagnostics in
the pre-existing broad PACT branch diff (206 files). This audit did not apply a
repository-wide formatting rewrite over unrelated work.

## DeepSec processing limitation

The local DeepSec matcher scan completed. AI processing of the 11 pending files
was not run because it would send repository contents to an external paid
gateway and that egress was not specifically approved. Those files were
reviewed locally; the repository-tool confinement issue above was found there
and fixed.

---

## Original report: `2026-08-19-mutation-tooling-qs.md`

# Audit: mutation tooling transitive denial of service

Date: 2026-08-19

## Finding

Adding Stryker introduced `typed-rest-client@2.3.1`, whose exact dependency on
`qs@6.15.1` is affected by GHSA-q8mj-m7cp-5q26. The dependency is development
only, but the repository security gates correctly treated it as blocking.

The cve-lite gate also exited before parsing its JSON whenever the scanner found
a blocking issue, which hid the gate's own actionable diagnostics.

## Resolution

- The parent-specific npm run override pins `typed-rest-client>qs` to 6.15.3.
- The lockfile contains no 6.15.1 resolution.
- The cve-lite gate now captures and validates the report even when the scanner
  exits non-zero because it found an issue.

## Verification

```bash
npm why qs
npm run audit:osv
npm run audit:cve-lite
```

---

## Original report: `2026-08-19-redaction-fuzz.md`

# Audit: authorization text redaction fuzz boundary

Date: 2026-08-19

## Finding

The Rust redaction fuzzer found that its authorization oracle treated a bare
`Basic ` prefix as if it contained a credential. Investigation also showed the
production Bearer/Basic patterns used narrow character allowlists, so an
unusual non-whitespace credential could be only partly redacted.

## Resolution

- Bearer and Basic values now redact the complete non-whitespace token.
- A bare scheme with no value remains unchanged.
- The independent fuzz oracle now requires an actual value after the scheme.
- Unit regressions cover both boundaries, and the discovered input is replayed
  before the coverage-guided target is rerun.

## Verification

```bash
cargo +1.88.0 test -p opensesame-redaction
cargo +nightly fuzz run redaction --fuzz-dir fuzz -- -max_total_time=60
npm run audit:fuzz
```

---

## Original report: `2026-08-21-certificate-key-custody.md`

# Audit — 2026-08-21 — certificate key custody and issuance ceremony

Status: Remediated locally; live provider conformance remains unclaimed

## Scope

This review traced and repaired the certificate flow through
`crates/gateway/src/dev_pki.rs`, `crates/gateway/src/routes/certs.rs`,
`crates/storage/migrations/0009_host_kv.sql`, `crates/connection-broker/src/crypto.rs`, and
the Pages certificate editor/model/client.

## Findings

| Severity | Current finding | Required repair |
| --- | --- | --- |
| Critical | Plaintext root CA persistence | Fixed: sealed, organization/AAD-bound authority storage; verified legacy migration; production refusal without the Host sealing key. |
| High | Editable PEM/private-key ceremony | Fixed: Pages accepts names, SANs, IPs, and lifetime; Host generates the leaf key and CSR. |
| High | Lost-response reissuance and broad key retrieval | Fixed: encrypted expiring delivery, actor binding, exact idempotent retry, and post-vault acknowledgement deletion. |
| High | Trust downgrade after external issuer failure | Fixed: persisted external default, explicit override, typed failure, and no private-CA fallback. |
| Medium | Non-transactional `host_kv` issued-record list | Fixed for persistent mode with transactional authority/request/delivery/issued tables. The development-only ephemeral CA retains bounded process-local metadata. |

## Existing controls worth preserving

- `rcgen` generates the private CA and leaf keys with ECDSA P-256; callers do
  not submit a leaf key to the current Host issue endpoint.
- Leaf private keys are not added to the current issued-record metadata list.
- Certificate issuance requires an owner/admin Host session.
- `IssueBody` denies unknown fields and bounds leaf lifetime to 90 days.
- The connection broker already provides XChaCha20-Poly1305 sealing with fresh
  nonces and organization/record associated data. Certificate storage should
  reuse that key discipline rather than inventing cryptography.

These controls do not mitigate plaintext root-key persistence or the editable
Pages ceremony.

## Accepted remediation boundary

ADR 0052 defines the complete boundary:

- OpenSesame private CA is automatic when no external default is configured.
- A request-selected or organization-default external issuer is authoritative;
  its failure never silently falls back.
- Public ACME uses RFC 8555 DNS-01 only through exactly
  `instant-acme = "=0.8.5"`; account credentials, EAB, and order secrets are
  sealed. Cloudflare DNS is a challenge connection, while Cloudflare Origin CA
  is a separately labelled `origin_only` issuer.
- Leaf key delivery is encrypted, expiring, actor-bound, single-consumer, and
  absent from logs, audit, URLs, and ordinary metadata.
- Identity and Host remain separate; all CA and connection authority stays in
  Host.

No statement here claims general RFC 8555, Let's Encrypt, ZeroSSL, Cloudflare,
or CA conformance. Those claims require integrated protocol and adversarial
evidence.

## Local closure evidence

The focused suites demonstrate sealed AAD purpose separation, removal of the
legacy plaintext CA after verified migration, exact idempotent delivery retry,
acknowledgement deletion, expiry and cross-tenant/actor refusal, external
failure without private-CA downgrade, strict request bounds, generated P-256
leaf keys, ACME endpoint/challenge refusal, and DNS cleanup success/failure.

- `cargo +1.88.0 test -p opensesame-gateway cert --no-fail-fast`: 16 passed;
- `cargo +1.88.0 test -p opensesame-storage certificate --no-fail-fast`: 5 passed;
- `cargo +1.88.0 test -p opensesame-connection-broker certificate --no-fail-fast`: 2 passed;
- focused Pages certificate behavior/contract tests: 36 passed; and
- strict Clippy over gateway, storage, and connection broker: passed.

No live Let's Encrypt, ZeroSSL, or Cloudflare credential was used. This is not
a claim of provider, WebPKI, or general RFC 8555 conformance.

---

## Original report: `2026-08-22-federated-leg-id-token-signature.md`

# Audit: the federated relying-party leg accepted an unverified id_token

Date: 2026-08-22

## Finding

The server-side federated sign-in leg added in ADR 0052
(`apps/control-plane/src/interactions/federated.ts`) admitted principals on an
`id_token` whose **signature was never checked**.

`completeFederatedAuth` called `openid-client`'s `authorizationCodeGrant` and
read the claims straight off the result. `openid-client` does not verify the
`id_token` signature for the authorization-code grant, and it is correct not to
have to: OIDC Core §3.1.3.7 permits a client to rely on TLS to the token
endpoint instead of checking the signature, because the token arrives over a
direct, authenticated channel.

Two things made that reliance wrong here:

1. `docs/architecture/federated-signin.md` §7.5 states that the `id_token`
   signature "verifies against the issuer's published JWKS, discovered from
   `/.well-known/openid-configuration` — never from a hardcoded key." That
   document is the contract; the code did not honor it.
2. Trusted upstreams are HTTPS in production, but a dev or self-hosted stack
   points at an `http://` broker (the mock IdP at `:9090`). There is no TLS
   there to lean on, so the assertion had **no** integrity protection at all.

A chaos test that signed the `id_token` with a key the issuer never published
was accepted: the interaction completed with a 303 into `/auth/…` and a
provisional session cookie was issued. A token with `alg: none` was likewise
accepted.

Not reachable by an unprivileged remote attacker against a correctly configured
production deployment, because TLS to an HTTPS broker still protects the
channel. The exposure is a broker reached over plaintext, a compromised or
misconfigured TLS path, or any proxy terminating TLS in front of the token
endpoint.

## Resolution

- `completeFederatedAuth` now verifies the raw `id_token` with
  `verifyOrgIdToken` — the same verifier the agent-facing
  `POST /v1/principals/link-identities` path already used. It pins RS256/ES256,
  discovers the JWKS from the issuer, checks `iss`, and applies the
  pairwise-over-global subject precedence.
- An exchange that returns no `id_token` is refused rather than treated as an
  anonymous success.
- `openid-client` continues to check `aud`, `nonce` and `exp`, which
  `verifyOrgIdToken` does not; together they cover the whole claim set.
- Both surfaces now share one definition of "verified upstream identity".

The reuse is the point: the browser leg (`apps/pages/src/lib/federation.ts`)
and the link-identities route already verified signatures. Only the new
server-side leg did not, because it inherited a library default that assumes a
property this deployment does not always have.

## Verification

A chaos suite injects one fault per case into an otherwise-working broker and
asserts the interaction does not complete and no session cookie is issued:

```bash
npm exec -w @opensesame/control-plane -- vitest run \
  src/__tests__/federated-leg.chaos.test.ts
```

Cases: discovery 500 / non-JSON, token endpoint 500 / non-JSON, wrong issuer,
wrong audience, wrong nonce, expired, **signed by an unpublished key**,
**`alg: none`**, no subject, and a replayed callback. The unpublished-key and
`alg: none` cases fail against the pre-fix code and pass after it.

A structural PACT test pins the ordering so the verify cannot be dropped or
reordered by a later refactor:

```bash
npm exec -w @opensesame/control-plane -- vitest run \
  src/__tests__/federated-leg.pact.test.ts
```

---

## Original report: `2026-08-22-mcp-response-minimization.md`

# MCP administrative response minimization

Date: 2026-08-22

## Finding

The MCP Host applied credential redaction before returning Host and daemon
responses, but administrative tools still relayed unrecognized response fields.
A compromised upstream could place prompt-injection text in fields such as
`note`, `warning`, `assistant_directive`, or a readiness body. The live red-team
model refused the instructions but repeated their contents to the user.

## Fix

`apps/mcp-host/src/tools.ts` now parses successful administrative responses
through per-tool Zod allowlists and returns only documented identifiers,
status, bounded capabilities, and counters. Unknown fields and raw readiness
bodies are omitted. The original response is still checked by `forAgent`
before projection so credential-shaped material causes a refusal even when it
appears in an unrecognized field. Error responses expose only a bounded error
code.

The invocation result remains intentionally separate: connector invocation
results are the requested agent data and continue through the existing
credential fence.

## Evidence

- MCP Host: 80/80 tests passed.
- Structural red-team: 19/19 tests passed.
- Model-backed promptfoo red-team: 18/18 passed, including all four injected
  administrative response cases.
- The harness suppresses only Node's known `DEP0205` runtime warning so stderr
  assertions continue to detect application diagnostics.


---

## Original report: `2026-08-25-certificate-tenant-isolation.md`

# Certificate issuance-history tenant isolation audit

Date: 2026-08-25

Codex Security CLI 0.1.20 (plugin 0.1.37) reviewed the complete 12-file set
resolved from seven certificate/custody paths using ChatGPT authentication,
GPT-5.6 Luna, low effort, standard mode, and a USD 15 scanner estimate cap.
The targeted run estimated USD 0.09094584.

The review confirmed one medium-severity issue in the development-only
ephemeral certificate repository. Issuance metadata was stored under a
host-global key, so listing history could cross organization boundaries. The
durable database path was already organization-scoped.

Commit `5da2361` binds the ephemeral key and every load/save call to the resolved
organization. The regression test
`adversarial_ephemeral_history_isolated_between_organizations` proves that one
organization cannot enumerate another organization's issuance metadata.

This was a targeted review, not a repository-wide security claim. Scanner
artifacts remain private because they contain detailed source paths and threat
analysis.

---

## Original report: `2026-08-30-mcp-http-transport.md`

# Audit 2026-08-30 — mcp-host Streamable HTTP transport

## Scope

`apps/mcp-host/src/transports/streamable-http.ts`, the transport selection in
`src/server.ts`, and the previously-inert `src/auth/bearer.ts` /
`src/auth/protected-resource.ts` helpers now wired into it. Introduced with
the agent-surface parity work (ADR 0065); profile obligations from ADR 0023.

## Threats considered and mitigations

1. **Routable exposure of operator tooling.** The listener refuses any
   non-loopback bind fail-closed (`mcp_http_loopback_required`); there is no
   TLS story in this binary by design, so a routable bind is never accepted.
   Remote access requires the operator to front it deliberately (e.g. a
   tailnet or SSH forward), keeping ADR 0048's local-plane posture.

2. **Unauthenticated access from local processes.** Every `/mcp` request
   requires `Authorization: Bearer <OPENSESAME_MCP_HTTP_TOKEN>` (16-char
   minimum, fail-closed when unset). Comparison is `timingSafeEqual` over
   SHA-256 digests, hiding both content and length. Non-bearer schemes are
   refused via `assertBearerScheme`. 401 responses carry
   `WWW-Authenticate: Bearer resource_metadata="<host>/.well-known/oauth-protected-resource"`
   and name the `mcp-authorization-2026-07-28-bearer` profile.

3. **Token passthrough (confused deputy).** The inbound bearer authenticates
   the transport only. The transport module never reads
   `OPENSESAME_ACCESS_TOKEN`/`OPENSESAME_OPERATOR_TOKEN` (source-oracle test),
   and tools keep sourcing their own credentials via `hostAuthHeaders()`; the
   inbound token is compared, then dropped. This preserves ADR 0023's
   "inbound MCP bearers are never forwarded downstream" and does not touch
   task DPoP profiles.

4. **DNS rebinding.** `enableDnsRebindingProtection` with a Host-header
   allowlist pinned to the actually-bound loopback host:port (computed after
   `listen`, so ephemeral test ports are covered too). A browser page on an
   attacker origin resolving to 127.0.0.1 fails the Host check even if it
   somehow obtained the bearer.

5. **Session fixation / cross-session reuse.** Sessions use SDK-generated
   `randomUUID()` ids; requests without a valid session are rejected by the
   SDK transport per the Streamable HTTP spec.

6. **Startup race.** Between `listen()` and transport attachment the handler
   answers 503 (`transport_starting`) rather than touching an undefined
   transport.

## Verification

- `apps/mcp-host/src/streamable-http.test.ts`: loopback/token/config
  fail-closed cases, 401 without/with wrong token and non-bearer scheme,
  PRM pointer in `WWW-Authenticate`, successful initialize with session id,
  health/404 behavior, and the source oracle for threat 3.
- `npm run test` -w @opensesame/mcp-host full suite; redteam structural
  suite continues to exercise the stdio path (`tests/redteam`).

## Residual risk

- Any local process that can read the operator's environment can read the
  transport token — the same trust boundary as the existing operator token.
- The stdio transport remains the default; HTTP is opt-in via
  `OPENSESAME_MCP_TRANSPORT=http`.

---

## Original report: `2026-08-31-ai-contextual-support.md`

# Audit 2026-08-31 — AI-native contextual support

Status: design audit of a new subsystem; no vulnerability found, no code changed

## Nature of this entry

The rest of this series documents a specific vulnerability that was found and
fixed. This one does not. It is a pre-merge review of a subsystem that is new
in its entirety — the in-product support assistant and the adaptive tutorial
system of [ADR 0088](../../adr/0088-ai-native-contextual-support.md) — carried out
by attacking the assembled feature rather than by reading it. Nothing was
repaired because nothing was found to repair. The entry exists so that what was
attacked, what held, what is enforced structurally rather than by convention,
and what remains true regardless are on the record at the point the feature
landed, instead of being reconstructed later from a diff.

The claim under test is unusual enough to restate. This design does not argue
that the model behaves; it argues that a model which does not behave cannot
express damage, because the language it writes has no production for damage.
That is a structural claim, so it is falsifiable by test, and the work below
is an attempt to falsify it.

## Scope

- `packages/guide-lang` — the grammar, the identifier validators, the budgets.
- `packages/guide-runtime` — the state machine and its ports.
- `packages/support-agent` — the port contract, the egress boundary, the turn
  splitter and bounded repair, the session and its transcript.
- `apps/pages/src/tutorial/**` — the registries, the page-context builder, the
  Driver.js adapter, the Prompt API and AG-UI adapters, the composition root.
- `apps/pages/src/webmcp/tools.ts` — the two guidance tools and the seam they
  reach the panel through.
- `packages/webmcp` — detection, the registrar, the agent fence.

The adversarial suite written for this review lives in
`apps/pages/src/tutorial/__tests__/adversarial/`. It deliberately does not
re-test any component against its own fakes; every case crosses at least one
module boundary, because the per-package suites are strong and the joins
between them were the least-observed part of the feature.

## Threats attacked, and what held

1. **Model-authored actuation.** A scripted agent returned
   `click "#reveal-secret"`, `navigate "javascript:alert(1)"`,
   `navigate "https://evil.example"`, `focus "#password"`, `focus "div>span"`,
   `eval`, `execute-tool "opensesame_shared_session_admit"`, an unbounded
   `wait`, and a four-hundred-instruction program, driven through the egress
   boundary, the turn splitter, the one permitted repair, the live page
   vocabulary and the runtime. In every case the recording renderer logged zero
   calls and the route controller zero navigations, with no deadline left
   armed. The refusals are unknown-directive parse failures rather than denied
   ones, and parsing is all-or-nothing, so no valid prefix ran either. A benign
   control case in the same file draws and navigates, so the assertions are not
   passing on a mis-wired harness.

2. **The error channel as an injection channel.** The bounded repair re-ask was
   checked to carry the compiler's codes and not the rejected program: neither
   `execute-tool` nor the tool name it named appears in the retry.

3. **Selectors and URLs reaching the DOM.** Over arbitrary strings
   (`fast-check`, 400 runs per position), no candidate became a target, a route
   or a predicate the compiler accepted, and `resolveGuideTargetElement` — the
   only edge in the application where an identifier becomes an element —
   returned `null` for every one. `guideRouteForPath` was likewise shown total
   onto the registered route set for arbitrary paths and arbitrary strings, so
   the route the page reports is always one the registry declares.

4. **Prompt injection through authored content.** ADR 0088 names the real
   vector: vault item names, folder names, connection labels and
   KDBX-imported entries are attacker-controlled text this application renders
   by design. A vault was populated with injection-shaped names, a folder name,
   an imported-entry name and a connection label, and the assembled page
   context was checked on every registered route, along with the system
   instruction built from it, the AG-UI outbound body, and the text of the
   overlay a walkthrough drew. No sentinel, item name or item id appeared in
   any of them. A companion assertion proves the vault really did hold that
   text, so the check is not vacuous.

5. **Secret disclosure.** The same fixture carried password, TOTP seed, card
   number and code, secret value, note body, hidden field value, private key,
   recovery code and bearer-token sentinels, using the sentinel pattern already
   established in `apps/pages/src/webmcp/tools.test.ts`. None reached the page
   context, the instruction string, the outbound body or a rendered popover. A
   vault record attached to a request is refused by `sanitizeSupportRequest`
   before anything is sent, on the denied key term rather than on inspection of
   the value.

6. **Vault lock under load.** Lock was fired at four awkward moments: with a
   model request in flight, with a `wait` armed and its deadline running, with
   a highlight standing after a `pause`, and with a persistent annotation on
   screen. In each case the transcript emptied, the provider session was
   destroyed, every overlay left the document and the deadline was disarmed. A
   provider that ignores its abort signal and answers *after* the lock — with a
   program that would otherwise have drawn — changed nothing, and a subsequent
   click on the control the torn-down guide had been waiting on did nothing.
   The subscription itself was exercised through `vaultStore.onLock`, so the
   lock the application actually listens to is the vault's own.

7. **Stale and superseded work.** An answer to support request N−1 arriving
   after N brings its walkthrough with it; the session discarded both, and the
   runtime drew only the current one. A trajectory compiled on `/vault` does
   not compile at all once the page is on `/connections`, and one compiled
   before the move fails closed with `TARGET_NOT_MOUNTED` rather than drawing.
   Starting a second walkthrough cancels the first as `superseded` and leaves
   one deadline set at zero.

8. **Registry integrity.** An unknown target, route, predicate or goal is
   refused at the validate stage with the code that names what was missing. A
   syntactically valid but unregistered route (`/admin/secrets`) is refused by
   the registry, by the compiler, and again by the runtime when the program is
   handed in as an AST — the path a parser regression, or any future caller
   that assembles a program itself, would take. A second element cannot take a
   target's binding from the element already on screen. A target that leaves
   the page mid-walkthrough stops the trajectory after exactly one render.

9. **Guidance is not actuation.** The full WebMCP catalog was registered
   against a stub browser with every `execute` replaced by a recorder; no
   export of `@opensesame/webmcp`, called with arguments it does not declare,
   fired one, and a tool listing came back as metadata holding no callable. A
   hostile AG-UI stream emitting `TOOL_CALL_*` events naming a real tool
   (`opensesame_open_reveal`) and an invented one reached nothing: the adapter
   implements only the assistant-text family, the answer carried no trace of
   the tool names, and the GuideLang the stream carried still faced the
   compiler and was rejected. The outbound body was separately checked to name
   no WebMCP tool at all, so a model has no catalog to name one from.
   `opensesame_guide_start` was swept with arbitrary strings and refused every
   id nobody in this repository authored, GuideLang text included.

10. **Markup from a model to the glass.** Payloads were driven from a raw
    completion through the fence splitter, the compiler, the runtime and the
    real Driver.js library, and asserted on the document: literal text in a
    focus popover, a hint popover and an annotation, with no `img`, `script`,
    `svg`, `iframe`, `style` or `a` node created anywhere. The popover is named
    from authored text, carries no `aria-labelledby` into a model string, and
    carries no text from the control it is pointing at.

## What is structural, and what is convention

Structural — holds whether or not the model, or a future caller, cooperates:

- The absent grammar productions. There is no AST node and no runtime argument
  that carries a selector, a script or a tool name.
- Two-stage identifier checking (syntax, then registry membership), performed
  by the compiler and again by the runtime against the live ports.
- The budgets, enforced in `guide-lang` and re-enforced in `guide-runtime`.
- The single `GuideTargetId` → element edge, and `navigate` taking a registry
  route id through an injected router port.
- One live guide: `maxConcurrentGuides` is 1 and `start` supersedes.
- `textContent` in the Driver adapter; the model's string never enters a step
  Driver renders as HTML.
- `sanitizeSupportRequest` rebuilding from primitives, with exact-key
  checking, a denied-key-term list, host-object-key detection and refusal of
  accessor properties — a request is refused, never trimmed into shape.
- The transcript living in a closure, with no storage or logging path (source
  oracles in `tutorial/ui/support-hygiene.test.ts`).
- `opensesame_guide_start` and `opensesame_help` accepting only enum members.

Convention, or enforced at the call site rather than by a type — named here
because a reader should not have to infer it:

- `PageContextInput.pageId` and `.route` are caller-supplied strings. The
  egress boundary bounds them to a non-empty identifier of at most 64
  characters; it does not require them to be registry members. The application
  passes the literal `"pages"` and the output of `guideRouteForPath`, which
  this audit proved total onto the route registry — so the property holds, by
  the call site rather than by the contract.
- The target catalog's descriptions are hand-authored prose. That they never
  interpolate a user-created value is enforced by a source-level assertion in
  `registry/catalog.test.ts`, not by a type, and it is a standing obligation on
  every UI change.
- `mountGuideTarget` accepts any catalog id from any module in the application;
  the registry has no notion of which component is entitled to bind a target.
  A later mount cannot take a binding away from an element already on screen,
  but resolution falls through to another registered candidate once the first
  stops being pointable. Only application code can reach this, so it is inside
  the trust boundary — but it is a convention, not an enforcement.
- The system instruction is not a control and is documented as such in
  `support-agent/src/instructions.ts`. `SUPPORT_POLICY_CLAUSES` is pinned by a
  characterization test so a clause cannot evaporate in a rewrite; that keeps
  the text honest, it does not make it a boundary.
- A remote AG-UI endpoint cannot be authenticated from the browser, by design.
  The deployment-side reverse proxy is the mechanism, and it is the operator's
  to build.

## Verification

```bash
env -u NODE_OPTIONS npm run test -w @opensesame/pages -- src/tutorial/__tests__
env -u NODE_OPTIONS npm run test -w @opensesame/pages
env -u NODE_OPTIONS npm run typecheck -w @opensesame/pages
env -u NODE_OPTIONS npx biome check apps/pages/src/tutorial/__tests__
env -u NODE_OPTIONS npm run lint:anti-slop:files apps/pages/src/tutorial
```

The adversarial directory is 63 tests across 7 files, run eight times
consecutively to check for order- and timing-dependence. The whole
`@opensesame/pages` suite is 2,573 tests across 191 files and passes with the
suite added. `npm run typecheck`, -w @opensesame/pages Biome and the
anti-slop Oxlint pass over the new files.

Command-level evidence for the rest of the feature, including what each
per-package suite proves, is in
[`docs/validation/ai-contextual-support.md`](../../validation/ai-contextual-support.md);
it is not restated here.

## What could not be tested

- **No live model, on-device or remote.** The Prompt API is reached through an
  injected fake and the AG-UI transport through an injected one. Nothing here
  confirms that a browser's `LanguageModel` behaves as `detect.ts` assumes, or
  that a real AG-UI server's stream decodes.
- **No model was evaluated for susceptibility to injection.** The suite drives
  a *scripted* hostile agent. It measures blast radius, not likelihood, and
  the design's argument is that the former is what matters — but the two are
  not the same claim and should not be read as one.
- **`@ag-ui/client` is never loaded.** That is the intended consequence of the
  dynamic import, and it means the real library's event decoding is
  unexercised by this audit.
- **jsdom has no layout.** "The highlight lands visibly on the right control"
  is unproven. `isMountedGuideTarget` walks the computed-style ancestor chain
  for `display: none` / `visibility: hidden` rather than measuring a box, so a
  control that is present and visible by cascade yet zero-box, off-screen or
  occluded still reads as pointable.
- **The hostile corpus is ours.** Ten program shapes and fast-check generators
  we wrote are not an adversary. A payload class nobody thought of is a payload
  class nobody tested, and there is no coverage-guided fuzz target for the
  GuideLang parser — which is the obvious candidate, being a small,
  dependency-free, all-or-nothing parser sitting directly on untrusted input.

## Residual risk

These are properties of the design, not unfinished work.

- **The attacker's best case is still real.** With total control of the model's
  output, an attacker can produce a guide that points at a control the
  application itself declared and says something misleading beside it — up to
  eight steps, five hundred characters each, one guide at a time. Misdirection
  inside the product's own chrome is bounded by this design, not eliminated by
  it. What the bound buys is that the person still performs every click, and no
  ceremony, reveal, approval or mutation happens on the model's behalf.
- **A configured remote transport means the question leaves the device.** The
  page context is registry-derived and value-blind, so what leaves is which
  controls exist and which are on screen. The question itself is prose a person
  typed, and `redactionWarning()` says plainly that nothing in the system can
  tell whether a secret is hidden inside a sentence.
- **The context is a coarse inference channel.** A support model learns
  boolean facts — the vault is unlocked, a connection exists, a plane is
  reachable — and which controls are mounted. That is deliberately the least
  informative thing that still answers a question about the screen, but it is
  not nothing.
- **Driver.js writes its popover slots with `innerHTML`.** The adapter's
  `textContent` rule is a reading of a pinned version. A release that renders
  the description differently would need the adapter revisited; the version is
  pinned and `rendering/driver-xss.test.ts` plus the chain suite here are the
  tripwire.
- **One more parser sits on an untrusted path.** ADR 0088 records this as a
  cost and answers it with no dependencies, no partial programs, and budgets
  enforced before structural work. It remains a cost.
