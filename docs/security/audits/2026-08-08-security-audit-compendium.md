# Security audit compendium — 2026-08-08

This compendium preserves the original point-in-time audit reports from 2026-08-08. Each section names its original repository path; the individual commits remain available in Git history.


---

## Original report: `2026-08-08-agent-claim-consent.md`

# Audit tick 42 — agent-claim consent proof, receipt error text

Date: 2026-08-08
Scanners: cargo-audit, cve-lite, ast-grep, clippy, semgrep, gitleaks, osv-scanner, cargo-deny, task-security battle test

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `POST /api/v1/agent-claims/{id}/complete` (Host API) minted a `user_code` at claim creation but never checked it. An operator token plus the claim token — both of which a co-resident process on the machine can hold — completed any pending claim, binding an agent instance to the bootstrap principal with no proof the human was looking at the device that asked to be claimed. | Require `user_code` in the body, compare it against `user_code_hash` with the constant-time `hash_eq`, and refuse the claim after five wrong codes. |
| Medium | Broker failure receipts stored the connector error verbatim (`json!({"error": e.to_string()})`). Receipts are durable and readable through `GET /v1/receipts/{id}`, so an upstream error carrying a URL with userinfo, a header echo, or a DSN was persisted in cleartext. | Pass the message through `opensesame_redaction::redact_text` before it reaches `safe_result_summary`. |
| Low | `assert!(receipt.assert_no_secret_leak())` panicked the request task — and the leak check only scans for secret *labels*, so a bare token value passes it anyway. A panic here is a 500 plus a poisoned span rather than a controlled denial. | Return an error (`anyhow::bail!`) so the invocation fails closed without unwinding through the handler. |

## Notes

- The gate is a pure `complete_gate(session, claim_token, user_code, attempts)` function, unit-tested for
  the wrong-code, wrong-token, no-code, and locked paths, so the ordering (claim token before user code,
  lock before either) cannot drift.
- The per-claim attempt counter is pruned alongside expired claim sessions in `create_identity`, so it
  cannot outgrow the claim map.
- `crates/daemon` now requires `user_code` for both approval paths (Host API agent-claim and the Identity API
  fallback) instead of only the fallback.

## Verification

- `cargo clippy --workspace --all-targets --all-features` — clean
- `cargo test --workspace` — clean
- gitleaks, osv-scanner, cargo-deny, cargo-audit, cve-lite, ast-grep, semgrep — clean
- `npm run test:task-access` — clean

---

## Original report: `2026-08-08-audit-chain-continuity.md`

# Audit 2026-08-08 — the audit chain restarted at genesis every boot

Date: 2026-08-08
Scanners: cve-lite, osv-scanner, cargo-audit, gitleaks, semgrep, ast-grep, clippy —
all clean. This is a fresh-eyes review of the chain added in
`2026-08-08-audit-chain.md`, three ticks ago.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `createChainedAuditSink` was constructed with no `tip`, so every process start began a new chain at `genesis`. The trail became one disconnected run per process lifetime — and a run beginning at genesis is exactly what deleting a contiguous tail looks like. The tamper evidence the previous tick claimed was, across any restart, absent. | The tip is read from the store before the first append. |
| High | Nothing could re-walk the trail. `list` ordered by `occurred_at`, which is a clock value with frequent ties, and a tie sorts arbitrarily — so the stored order was not the append order and a deletion could not be told from a reordering. | New `seq` column (`bigserial`); both repositories now return append order. |
| Medium | `GET /v1/audit/events/verify` walked the *caller's own* events. One principal's events are not adjacent in the chain, so consecutive members of that slice never link to each other. The route worked around this by checking each event against its own digest, which detects `altered` and can never detect `broken` — the deletion case the chain exists for. | The route walks the contiguous run instead. |

## What changed

- `ChainedAuditSinkOptions.tip` accepts a function, resolved once before the first
  append and inside the queue that already serializes appends, so concurrent first
  writes cannot each read a tip. A store that cannot be read leaves the tip at
  genesis and the event is still written: losing the event would be worse than a
  chain with a visible seam.
- `audit_events.seq` is a `bigserial` with its own index (migration
  `0005_audit_seq.sql`). The Postgres repository orders by it; the in-memory one
  uses insertion order, which is the same thing. Neither exposes `seq` in the
  domain type — it is the store's order, not an event's field.
- The verify route lists unfiltered, measures the first event against the digest it
  already claims rather than against genesis (the window starts mid-chain), and
  returns no event contents. `eventId` is withheld unless the failing event is the
  caller's own: that somebody's trail was tampered with is worth telling any
  principal, whose it was is not.

## Not fixed here

- A digest is still not a signature. A writer that can recompute every later digest
  can still rewrite the trail; that threat needs a signer, as the original note said.
- The verify walk covers the newest 200 events. A tamper older than that window is
  not reached, and nothing yet stores a checkpoint the window can be anchored to.
- There is no repository method that deletes an audit event, which is why the
  removal case is covered by unit tests in `packages/audit` rather than through the
  API.
- Existing rows get `seq` values in whatever order Postgres assigns during the
  `ALTER TABLE`. For a trail written before this migration that order is the
  physical one, which is usually insertion order but is not guaranteed to be.

## Verification

- `packages/audit` — 14 passed (3 new: the tip is read rather than reset, it is read
  exactly once under concurrent appends, and an unreadable tip still writes the event)
- `apps/control-plane` — 34 passed (the verify test now proves the walk covers the
  whole run, using an event belonging to another principal)
- `packages/database` — 9 passed; `npm run -r typecheck` and the full workspace suite green
- cve-lite, osv-scanner, cargo-audit, gitleaks, semgrep, ast-grep, clippy — clean

---

## Original report: `2026-08-08-audit-chain.md`

# Audit 2026-08-08 — tamper evidence for the control-plane trail

Tick 64 recorded that control-plane audit events carried no integrity chain: no
previous-event digest, no signature, unlike `InvocationReceipt` on the Rust side.
An event could be edited in place or removed and the trail would still read as a
trail. This closes that.

## What was added

`packages/audit/src/chain.ts` computes a digest per event over its own fields plus
the digest of the event before it, and `createChainedAuditSink` wraps the audit
repository so every append is linked. `verifyAuditChain` re-walks a run of events
and distinguishes three failures:

- `unlinked` — the event carries no digest at all (a row written before this, or by
  something that bypassed the sink),
- `altered` — the event's contents no longer produce the digest stored beside it,
- `broken` — the event does not follow the one before it, which is the shape a
  deletion or a reordering takes.

Appends are serialized through the sink. Two events sharing a predecessor would
each claim to follow it and one would be unverifiable, so a second append waits
for the first to land — and the tip only advances once the store accepted the
event, so a failed write leaves no gap for the next event to point at.

Metadata is digested with sorted keys, because object key order is not evidence
and must not change a digest.

## Where it is wired

`createControlPlane` wraps `repos.auditEvents` before anything can use it, so all
existing call sites are chained without changes. `GET /v1/audit/events` now returns
`digest` and `previousDigest`, and `GET /v1/audit/events/verify` re-walks the
caller's own trail, answering 200 or 409 with the reason and the offending event.
A caller sees a subsequence of the whole chain, so that endpoint checks each event
against its own digest rather than against its neighbour.

Postgres gains two nullable columns (`0003_audit_chain.sql`); rows written before
this migration simply verify as `unlinked` rather than being mistaken for intact.

## What a digest does not do

This is not a signature. It stops a trail being quietly rewritten by something
that cannot recompute every later digest — a hand-edited row, a partial
compromise, a buggy migration. A writer that can rewrite the whole chain can still
produce a consistent forgery; that threat needs a signer, and the tip published
somewhere the writer does not control.

---

## Original report: `2026-08-08-audit-trail-fidelity.md`

# Audit tick 64 — a trail that can show an attack

Scanners (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit, cargo-deny, clippy,
task-security-battle-test) were clean. The reading was `packages/audit`, the audit
repositories in `packages/database`, and the events the control plane actually
writes.

## Refusals were not recorded (fixed)

Every audit event in the control plane was `outcome: "succeeded"` bar one. That is
the single shape of trail that cannot show an attack: five wrong TOTP codes
followed by one right one read as one ordinary login, and guesses against a
claim's ~40-bit user code left nothing behind at all — even though both paths
already count failures to close a fence.

Denials are now written where the fences are:

- `mfa.totp.verify` — `bad_code` and `too_many_attempts`
- `mfa.passkey.assert` — `assertion_failed` and `too_many_attempts`, with the
  credential id as the target
- `claim.complete` — `invalid_user_code` and `too_many_attempts`, against the
  claim id

## The metadata allowlist dropped what the call sites recorded (fixed)

`redactAuditMetadata` keeps allowlisted keys only, and the allowlist did not
contain `kind`, `issuer`, `tenant`, `slug`, `note`, `sectorIdentifier`,
`admissionMode`, or `previousClientId` — all of which call sites pass. So
`principal.link_identity`, the event that carries an assurance upgrade, recorded
`action` and nothing about which issuer or subject kind granted it. Those keys are
now allowlisted.

Some of them are request-shaped (an issuer URL, a sector identifier), so string
values are bounded at `AUDIT_VALUE_MAX_LENGTH` (256) and truncated rather than
dropped: a shortened issuer still tells a reviewer what happened, and the store
no longer grows to whatever length a caller sends.

## Read and left alone

- The deny-key regex already strips token, secret, code-verifier, user-code and
  device-code shaped keys before the allowlist is consulted, and non-scalar values
  are dropped.
- `auditEvents.list` filters by principal in both the memory and Postgres
  repositories, so the endpoint is not a window onto another principal's trail.
- The Postgres repositories are Drizzle query builders throughout — no string-built
  SQL — and their compare-and-swap updates gate on the expected version.

## Not addressed

Control-plane audit events carry no integrity chain: no previous-event digest and
no signature, unlike `InvocationReceipt` on the Rust side. Tamper evidence for
this trail is a design change (hash chaining plus a signer), not an audit patch.

---

## Original report: `2026-08-08-authority-bounds.md`

# Audit 2026-08-08 — three deferred authority bounds

Three findings that earlier ticks recorded as "needs a data-model change" turned
out to need less than that.

## 1. A grant's action list constrained nothing (tick 51)

`authorize_authority_use` overwrote the requested action with
`grant.actions.first()` before handing the request to the policy engine. The
engine's check is "is this action in the grant?", so the grant was being compared
against itself: a grant listing `repository.read` authorized a
`pull_request.create` all the same, and only the first action was ever exercised.

A use now names the action it exercises. The named action must appear in
`grant.actions`, and a use that names none is denied rather than assigned one —
a use with no action cannot be checked against a list of actions. Arguments moved
into an `AuthorityUse` struct, since the parameter list had grown past reading.

## 2. A task could be labelled with somebody else's organization (tick 69)

`start_task` took `organization_id` from the body and checked only that the caller
owned the `principal_id`. Invocation was already closed — `invoke_frozen` compares
the intent's organization against the grant's — but the task record and its audit
trail carried a label nobody verified.

The organization must now be one the caller holds authority in, which in this
deployment is the bootstrap organization; anything else is `403
organization_mismatch`. When the gateway gains a real membership store the same
check reads from it instead of from the bootstrap.

## 3. L2 took the placeholder and the credential from the request (tick 65)

`HostRuntime::invoke_l2_placeholder` read both `placeholder` and `material` from
request parameters. It was a demo path, so the "secret" was the caller's own
string and nothing leaked — but the shape was wrong, and the shape is what a real
L2 path would inherit.

The host now holds a `HostConnection` per connection reference: the projection it
issued and the credential it will write behind that projection's placeholder. A
request may name the connection, because that is what a reference is for, and it
must repeat the placeholder in order to place it — but a request that names
`material` is refused outright, a request naming a placeholder other than the
issued one is refused, and a connection this host holds nothing for cannot be
exercised at all.

## Not fixed here

- The gateway's HTTP surface has no test harness; these routes are covered only by
  module-level unit tests, so the organization fence is verified by construction
  and by `cargo clippy`/`cargo test`, not by a request. A harness is worth its own
  change.
- Task ceilings are still not bounded against issued grants; that still needs a
  grant issuance path for ordinary principals.

## Verification

- `cargo test --workspace` — green
- `cargo clippy --workspace --all-targets -- -D warnings` — clean

---

## Original report: `2026-08-08-browser-ceremony.md`

# Audit tick 67 — the browser client trusted whatever answered discovery

Scanners clean (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit, cargo-deny). Read
`packages/sdk-browser` — PKCE, the redirect callback, and session storage.

The discovery document decides where this client sends the authorization code and the
PKCE verifier. It was fetched and used as given.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | The discovery document was never checked against the configured issuer, and its `authorization_endpoint` / `token_endpoint` / `end_session_endpoint` were used at any scheme. Whatever answered `/.well-known/openid-configuration` chose where the code and verifier went. | `meta.issuer` must equal the configured issuer; every endpoint used must be https (http on loopback only). |
| High | The `nonce` was minted, sent, and then never checked. The `sub` cached from the returned `id_token` was read straight out of an unverified payload, so an injected id_token decided the identity the application saw. | `assertIdTokenAddressedToUs` checks `iss`, `aud`, and `nonce` before anything is cached, and refuses the exchange otherwise. |
| Medium | `issuer` and `apiBase` were accepted at any scheme, so access tokens and claim approvals could be sent over cleartext. | Both validated at construction. |
| Medium | The stored PKCE verifier was removed only on the success path. A callback that failed on `error=`, on a state mismatch, or on unreadable storage left the verifier behind for a second attempt to spend. | Verifier is removed before the state is compared, and on every failure path. |

## Tests

`packages/sdk-browser/src/client.test.ts`: an id_token with a foreign nonce, audience,
or issuer is refused and leaves no session; a discovery document naming a different
issuer is refused; cleartext issuer, `apiBase`, and `token_endpoint` are refused while
loopback stays usable; and the stored verifier is gone after both a forged state and a
refused authorization.

## Notes

The browser cannot verify an id_token signature, so the access token remains the
authority and the id_token is only a hint — but a hint failing these three checks is
somebody else's token, and caching a `sub` from it hands the application the wrong
identity. Consumers (`apps/pages`, `apps/console`, the example RPs) default to loopback
and wrap construction in `try`/`catch`, so a cleartext issuer now surfaces as an error
rather than a silent downgrade.

---

## Original report: `2026-08-08-browser-followups.md`

# Audit 2026-08-08 — four browser-surface follow-ups

The remaining "not fixed here" items from the Pages, console and sealed-store
ticks.

## 1. Cookie-authenticated mutations had no CSRF story (tick 71)

The Pages outbox sent `credentials: "include"` to the Identity API, and the
control plane accepted its session cookie as authentication for any request. A
cookie travels because the browser decided to send it, not because the page meant
to send it, so on its own it says nothing about who asked.

Two changes, in the order that matters:

- **The service is the fence.** A mutation authenticated by cookie must also carry
  an `Origin` this deployment listed in `OPENSESAME_CORS_ORIGINS`, or the service's
  own origin. Otherwise the cookie does not authenticate and the request is 401. A
  bearer token is unaffected: a caller that had to attach a token was not tricked
  into attaching it. Reads are untouched — a forged read is not a forged write.
- **The page stops asking for what it cannot use.** Pages sends the ambient session
  only to its own origin. The cookie is `SameSite=Lax`, so a browser was already
  dropping it from a cross-site POST; asking anyway only obscured that the call was
  relying on credentials it could not see.

`SameSite=Lax` remains set. It is a browser default and does not separate sibling
origins on one site, which is why the origin check exists as well.

## 2. The pre-PBKDF2 unlock record was accepted forever (tick 72)

An unsalted single-round SHA-256 record was upgraded on every successful unlock,
but accepted indefinitely. `LEGACY_PIN_RETIRED_AFTER_MS` (2027-01-01) ends it:
past that date the record is refused rather than upgraded, and a person sets a new
PIN. Nothing is lost by refusing — this record gates the session, it does not key
the vault — and every unlock before then rewrites it at current cost, so the only
people left on it are people who have not unlocked in months.

## 3. Nothing bound a sealed store to its device (tick 73)

Validation stopped a malformed file but not a well-formed one copied from another
profile: `apps/pwa` and Pages read `cursor.device_id` out of the store and adopt
it, so a file copy handed over an identity and an epoch. A store's cursor must now
name the device it is stored under — `persistSealedStore` refuses to write another
device's store, and `loadSealedStore` reads a mismatch as absent.

## 4. The console's operator token could be baked into a bundle (tick 71)

`VITE_*` variables are inlined into shipped JavaScript, so a production build with
`VITE_OPENSESAME_OPERATOR_TOKEN` set published a machine-local shared secret to
everyone who loaded the page. Keeping it out was a deployment convention; the
production build now refuses outright. The existing runtime fence still applies:
the token is only ever sent to a loopback gateway.

## Not fixed here

- Client-side lockout state remains advisory. Anything that can write our storage
  can reset the counter, and nothing in a browser prevents that; the iteration
  floor is what costs an attacker something.
- A sealed store is still sealed by whatever sealed it. `sealDevOnly` remains an
  XOR fenced to dev/test and the real AEAD lives in the Rust wasm build.

## Verification

- `apps/pages` 18 tests, `packages/client-core` 7, `apps/control-plane` 34 (1 new)
- `npm run -r typecheck`, full workspace tests green
- `npm run build` -w @opensesame/console refuses with the token set, builds without it

---

## Original report: `2026-08-08-browser-surface-destinations.md`

# Audit 2026-08-08 — where the browser apps send secrets, and what their outbox holds

Tick 71 read the two browser surfaces that nothing had audited yet: the offline
Pages app and the console. Both hand a machine-local secret to a URL that somebody
else chose, and the Pages outbox treats durable storage as trustworthy input.

## The operator token followed a configurable URL off the machine

`apps/pages` persists `hostApi` and `identityApi` as plain strings with no
validation, and `TaskPage` attaches `Bearer operator:<token>` to whatever `hostApi`
names. The operator token is a secret shared between processes on one machine — the
same secret the daemon was stopped from forwarding in tick 61 and that `mcp-host`
already confines to loopback. Here there was no such fence: any `hostApi` (including
`http://` to a remote host, or one with embedded credentials) received it.

The console has the same shape from the other direction: `VITE_OPENSESAME_OPERATOR_TOKEN`
is a build-time variable, so the token can end up inside the shipped bundle and was
sent to whatever gateway that build pointed at.

Both now go through `operatorHeadersFor(base, token)`, which offers the bearer only
when the base names this machine. `apps/pages` additionally refuses a base it would
not accept — https, or http on loopback, never with embedded credentials — both when
saving settings (the form now says why) and when reading them back, because storage
is not a place where a destination earns trust by having been written once.

## The offline outbox was an unvalidated to-do list of privileged calls

`loadQueue` parsed OPFS JSON and cast it to `QueuedAction[]`. A flush turns each
entry into a device approval or a claim completion, so anything able to write our
storage could stage a device approval the person never saw and have the app perform
it on the next flush. Entries also never expired, were never capped, and one that
could not succeed threw out of the flush loop and blocked everything behind it —
leaving claim tokens sitting in durable storage indefinitely.

The queue is now read as untrusted input: shape-checked per kind, claim tokens
required to look like claim tokens, entries older than a day dropped (their tokens
are dead by then anyway), the list bounded to 32, and a failing item counting its
attempts until it drops itself instead of holding the outbox hostage.

## The screen showed the secret half of a claim token

The queue rendered `claim token …${claimToken.slice(-8)}` — and the token is
`osc_clm_<id>.<secret>`, so those last eight characters come from the secret half.
It now shows the id half, and the panel's copy no longer claims the queue holds
"no secrets", because a queued claim carries its token.

## Not fixed here

- ~~The Pages outbox flush still sends `credentials: "include"`~~ — closed in
  `2026-08-08-browser-followups.md`: cookie-authenticated mutations require an
  allowlisted `Origin`, and Pages sends the ambient session only to its own origin.
- ~~The console's operator token is still readable in a build that sets the
  variable~~ — closed: a production build refuses when the variable is set.

---

## Original report: `2026-08-08-claim-verify-disclosure.md`

# Security audit — claim verification page disclosure — 2026-08-08

Branch: `chore/audit-tick26`

## Scanners

| Check | Result |
|------|--------|
| gitleaks (tree + history) | CLEAN |
| osv-scanner / cargo-audit / cargo-deny | CLEAN |
| Residual review | `/v1/claims/:id/verify` still disclosed claim state by URL alone after #46 |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Low | Verification landing page revealed claim existence + state (`pending`/`completed`/`denied`) to anyone with the URL | Page no longer loads the session; renders neutral console hand-off. Test asserts no state string leaks |

Daemon `/v1/*` handlers re-checked: every mutation and read (`list_sessions`, `mint_capability`,
`introspect_capability`, `revoke`, toolbar endpoints) requires the operator token.

## Gate

```bash
npm run test -w @opensesame/control-plane
npm run typecheck -w @opensesame/control-plane
```

---

## Original report: `2026-08-08-cli-ceremony.md`

# Audit tick 68 — the CLI took the issuer's word for where to send the code

Scanners clean (cve-lite, semgrep, ast-grep, gitleaks, osv-scanner, cargo-deny). Read
`packages/sdk-cli` — loopback login, device flow, control-plane client — and the
`packages/cli` dispatch that drives them. Same class of gap as ticks 66 and 67, on the
third surface: a discovery document used as returned.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | Neither `loopbackLogin` nor `DeviceFlowClient` compared the discovery document's `issuer` to the configured one, or required any endpoint to be reachable over a channel nobody can rewrite. Whatever answered chose where the authorization code, the PKCE verifier, and the device code went. | `assertDiscoveryBelongsToIssuer` plus `assertSecureUrl` on the issuer and every endpoint used (https, or http on loopback). |
| High | The device flow printed `verification_uri` and `verification_uri_complete` straight from the response for a person to open and type a code into. A tampered issuer got a phishing page delivered in the CLI's own voice. | Both URIs held to the same bar as the endpoints. |
| Medium | `pollClaim` interpolated the claim id into the request path unencoded, so an id carrying `../../` aimed the request — and the `x-claim-token` header with it — at another endpoint. | `encodeURIComponent`. |
| Medium | `createControlPlaneClient` accepted any `baseUrl` scheme while attaching a bearer token. | Validated at construction. |
| Medium | The loopback server had no deadline. An abandoned login left a port listening for the rest of the session. | Default 5-minute timeout, configurable, with the handle unref'd. |
| Medium | Any local request to the loopback port ended the login: a callback with a wrong state rejected the promise and closed the server, so any process on the box could cancel a sign-in. | A callback without the minted state gets a 400 and the login keeps waiting. |
| Low | `server.close()` waits on the keep-alive socket a browser leaves open, so the CLI could sit there after a successful login. | `closeAllConnections()` on every exit path. |
| Low | `pollUntilComplete` ignored `expires_in` and polled forever against a server that only ever says `authorization_pending`; `slow_down` raised the interval without bound. | Deadline from `expires_in`; interval capped at 60s. |
| Low | `redactSecrets` missed `code_verifier`, `client_assertion`, `operator_token`, `authorization`, `password`, and api keys. | Pattern extended, with `token_type` and `user_code` deliberately left readable. |
| Low | A thrown endpoint refusal reached the top-level `await` in `bin.ts` as an unhandled rejection. | `runCli` dispatch wrapped: the message is printed and exit code is 1. |

## Tests

New `loopback.test.ts` runs the real server: a redirect carrying the minted state
completes, a stray local callback gets 400 without ending the login, an absent redirect
times out, and a mis-attributed or cleartext discovery document is refused. New
`control-plane.test.ts` pins the path encoding and the cleartext refusal.
`device-flow.test.ts` gains refusals for a foreign issuer, a phishing verification URI,
a cleartext issuer, an expired device code, and an unbounded poll interval.

---

## Original report: `2026-08-08-cli-session-hygiene.md`

# Audit tick 70 — the CLIs printed and stored tokens more freely than they meant to

Scanners clean (cve-lite, semgrep, ast-grep, gitleaks, osv-scanner, cargo-deny). Read
the two command-line surfaces that hold credentials on disk: `packages/cli`
(identity CLI) and `apps/cli` (Rust CLI).

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | The Rust CLI printed the operator token inside a copy-and-paste `curl` line on every device login. That is a machine-wide shared secret written to terminal scrollback, pipes, and CI logs. | The line names `$OPENSESAME_OPERATOR_TOKEN` and lets the shell read it. |
| High | The same login printed the whole session object, access token included. | Tokens redacted from what is printed; the file still holds the real thing. |
| High | Both CLIs wrote the session file and *then* chmod'd it to 0600, so it existed world-readable for a window — long enough for another account to open it and keep the handle. `writeFile`'s `mode` also does nothing to a file that already exists, so one left at 0644 by an earlier version stayed there. | Rust: `OpenOptions::mode(0o600)` at creation, then set the mode again for a pre-existing file. Node: write a temp file at 0600 and rename over the target. |
| Medium | The identity CLI read whatever session file it found. A bearer token in a group-readable or group-writable file is one every account on the box holds — or gets to choose. | The file is refused, loudly, if any bits outside the owner's are set. |
| Medium | A session saved for one issuer was sent to whatever `--api`/`OPENSESAME_API_URL` named, and its `expiresAt` was never consulted. | `sessionFor` hands back a session only for the issuer that minted it, and only before it expires. |
| Medium | The Rust CLI passed the server's `expires_in` straight to `chrono::Duration::seconds`, which panics rather than errors on an out-of-range count. `interval` was likewise unbounded. | Both clamped. |
| Low | `directories`-derived config dir aside, `sessionPath()` in the Node CLI preferred the ambient `XDG_RUNTIME_DIR` over the explicit `OPENSESAME_STATE_DIR`. | Explicit setting wins. |
| Low | The daemon log file was created at the umask's mode although the daemon's own output lands in it. | Created 0600. |
| Low | `device_login` unwrapped `device_code`, `user_code`, and `verification_uri` out of the response, so a malformed answer panicked the CLI. | Each is a named error now. |

## Tests

`packages/cli/src/session.test.ts` (new) drives `runCli` against a temp state dir: the
session lands at 0600, a 0644 file left by an earlier version has its bits taken back,
a file others can reach is refused out loud, one issuer's token is never sent to
another, and an expired session is not reused. `apps/cli` gains unit tests for
`write_private` over a pre-existing 0644 file and for the device-code TTL clamp,
including a pinned demonstration that chrono panics on `i64::MAX`.

---

## Original report: `2026-08-08-client-registration.md`

# Audit tick 62 — what a client may say about itself

Scanners (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit, cargo-deny) were
clean. The reading was `packages/oauth-provider` and the client registration path
in `apps/control-plane`.

## A registration could widen its own flows (fixed)

`CreateOAuthClientRequestSchema` took `grantTypes`, `responseTypes`, and
`tokenEndpointAuthMethod` as free-form strings. A registrant could therefore
declare `implicit`, `client_credentials`, or token exchange for itself, and
`responseTypes: ["token"]` — a token delivered in a URL fragment with no PKCE, or
a client acting with no user behind it.

The provider happens to disable `clientCredentials` today, which is why this was
inert rather than exploitable. That is a property of the current provider
configuration, not of the record; the record is what admission reads
(`assertAdmissible` consults `client.grantTypes`) and what a future wiring would
hand to the provider. All three fields are now allowlisted: authorization code,
refresh, and device code; `code` responses only; and a known set of client
authentication methods.

## Any principal could claim another's sector identifier (fixed)

`sectorIdentifier` was `z.string().min(1)` — any label, claimable by anyone. A
sector decides which pairwise subject a client sees, so two clients sharing one
see the same `sub` for the same person. Registering a client under another
owner's sector was therefore a way to learn the subject that owner's clients see,
which is exactly the linkage pairwise subjects exist to prevent.

Two changes: a sector identifier must now take the spec's form (an https URL with
no query, fragment, or credentials), and registration refuses with `409
sector_identifier_taken` when a live client belonging to a *different* principal
already uses it. Sharing a sector between one owner's own clients stays allowed —
that is a deliberate choice about which of their clients see one subject.

## Read and left alone

- `resolveJwks` refuses an ephemeral keypair in production, and a persistent
  adapter is required there too, so grants and revocation survive a restart.
- `getResourceServerInfo` rejects any resource indicator outside the allowlist
  (`invalid_target`), and audiences are canonicalized before use.
- Redirect URIs were already confined to https, loopback http, and reverse-DNS
  private-use schemes, with no fragment or credentials.
- `MemoryPairwiseSubjectStore` mints a random 32-byte subject per
  (principal, sector) and persists the mapping, so no secret rotation can rewrite
  subjects.
- `rotate` mints a new client id and revokes the old; it is not a secret rotation
  because this registry holds no client secrets.

---

## Original report: `2026-08-08-daemon-operator-forwarding.md`

# Audit tick 61 — the operator token stays on this machine

Scanners (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit, cargo-deny, clippy,
task-security-battle-test) were clean. The reading was `crates/daemon` and
`crates/audit`.

## The daemon handed its operator token to whoever `OPENSESAME_SERVER` named (fixed)

Three daemon routes — `approve_device`, `approve_claim`, and
`operator_invoke_l1` — forwarded to the Host API with
`x-opensesame-operator: <token>` attached. The Host API base is configuration
(`OPENSESAME_SERVER`, `--host-api`), defaulting to loopback but not confined to
it, so a remote value sent the host's operator secret to whoever answered there,
in cleartext over `http://`.

That secret is the daemon's whole authorization story: every mutating local route
gates on it. `apps/mcp-host/src/host-api.ts` already refuses to offer it to a
non-loopback target; the daemon now agrees. Forwards that carry the token go
through one helper that denies with `503 remote_host_api` when the base does not
name this machine, rather than reaching a remote at the cost of the secret.

The loopback test lives in `crates/host-core` as `daemon::base_url_is_local`,
beside the existing listen-address policy. A base carrying userinfo is not local:
`http://127.0.0.1@evil.test/` is a request to evil.test.

## Minted capabilities accumulated for the life of the process (fixed)

`mint_capability` inserted into the capability map and never removed anything.
Expired capabilities were already inert on introspect, so they were pure growth.
Minting now drops expired rows first.

## Read and left alone

- `crates/audit`: the receipt verifier registry from an earlier tick is wired
  (`resolve_receipt_verifier`, published key ids), receipts bind
  `authority_key_id` into the signed digest, and an unknown key reports as
  unknown rather than as tamper evidence.
- The daemon's Identity API fallback carries no operator token, only a
  caller-supplied bearer.
- `mint_capability` picks the first session in the map, which is a dev stub rather
  than an authorization decision; it is operator-gated and mints no credential
  material.

---

## Original report: `2026-08-08-device-code-digests.md`

# Security audit — device code storage + approval fence — 2026-08-08

Branch: `chore/audit-tick27`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / semgrep / npm audit | CLEAN |
| task-security-battle-test / battle-test | CLEAN |
| Residual review | Host API device flow held `device_code` / `user_code` in cleartext and compared codes with `==` |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | Pending device grants stored the device code as a cleartext map key and the user code verbatim, so a memory/state disclosure yielded usable bearers | Key the pending map by `hash_secret(device_code)`; store `user_code_hash` only (matches claim sessions) |
| Medium | `POST /api/v1/device/approve` compared user codes with `==` and allowed unlimited guesses per pending grant | Constant-time `hash_eq`; misses increment `approve_attempts` and codes are burned after 5 |

Device codes remain UUID-derived (high entropy); the user code (~35 bits) is the
credential the attempt cap protects.

## Gate

```bash
cargo +1.88.0 clippy -p opensesame-gateway --all-targets -- -D warnings
cargo +1.88.0 test -p opensesame-gateway --bins
./scripts/test/battle-test.sh
```

---

## Original report: `2026-08-08-discovered-endpoint-fence.md`

# Audit 2026-08-08 — an issuer could aim our requests at our own network

Date: 2026-08-08
Scanners: cve-lite, osv-scanner, gitleaks, semgrep, ast-grep — all clean. This is a
fresh-eyes review of the JWKS discovery added in
`2026-08-08-resource-server-sdk.md`, four ticks ago, which turned out to be
one instance of a pattern in three packages.

## Finding

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium–High | Endpoints taken from a remote issuer's discovery document were checked with `assertSecureUrl`, which permits cleartext on loopback. That is the right affordance for a URL an operator configured and the wrong one for a URL a remote party supplies: any issuer could name `http://127.0.0.1:9200/jwks`, `https://169.254.169.254/…`, or a private-range address, and the process would make that request. Affected `jwks_uri` (`sdk-server`), `authorization_endpoint` / `token_endpoint` / `device_authorization_endpoint` (`sdk-cli`), and the same three in `sdk-browser`. | New `assertDiscoveredUrl` / `assertDiscoveredJwksUri`: a discovered endpoint may name private space only when the issuer is itself private. |

Reproduced before the fix: with `issuer: "https://remote.example"` and a discovery
document naming `http://127.0.0.1:9200/jwks`, `discoverJwksUri` resolved without
complaint and the verifier went on to fetch keys from it.

What makes this worth more than a lint: in `sdk-cli` the discovered
`token_endpoint` is where a device code and a client assertion get POSTed, and in
`sdk-browser` the discovered `authorization_endpoint` is where the user is
redirected. A remote issuer choosing those targets is choosing where a credential
goes, not merely causing a wasted request.

## The rule

A discovered endpoint may name loopback, `10/8`, `172.16/12`, `192.168/16`,
`169.254/16` (link-local, which is where cloud metadata lives), `fc00::/7`,
`fe80::/10`, `0.0.0.0`, or a `.internal` / `.local` name **only when the configured
issuer is itself private**. That is the local development case, where both ends are
on this machine and nothing is being crossed. A remote issuer naming a public host
that is not its own origin is still allowed: plenty of real issuers publish keys on
a separate hostname, and refusing that would break them for no security gain.

An explicitly configured `jwksUri` keeps the old rule. It is the operator's own
choice, and loopback is the point of it in development.

## Not fixed here

- The check is on the hostname as written. A public DNS name that resolves to
  `127.0.0.1` or into a private range still passes, and nothing here can see that —
  a resolving fence belongs in the fetch layer, not in a URL assertion.
- The discovery response body is read with `res.json()` and has no size bound, so a
  hostile issuer can still make a client read a large document.
- `sdk-server`, `sdk-cli` and `sdk-browser` each carry their own copy of these host
  predicates because they target different runtimes. Three copies is three chances
  to fix only two of them next time.

## Verification

- `packages/sdk-server` — 16 passed (2 new: nine private targets refused across both
  schemes; a public cross-host key set and a loopback-issuer pair still accepted)
- `packages/sdk-cli` — 16 passed (2 new: a remote issuer naming a loopback
  `token_endpoint` refused; a loopback issuer's loopback endpoints untouched)
- `packages/sdk-browser` — 11 passed; `npm run -r typecheck` and the full workspace
  suite green
- cve-lite, osv-scanner, gitleaks, semgrep, ast-grep — clean

---

## Original report: `2026-08-08-dpop-replay-cache.md`

# Security audit — DPoP replay cache bounds — 2026-08-08

Branch: `chore/audit-tick31`

## Scanners

| Check | Result |
|------|--------|
| cve-lite / clippy (workspace) | CLEAN |
| gitleaks working tree | CLEAN (history warnings still from the unmerged pages-vault branch) |
| `cargo test --workspace --lib` | CLEAN |
| Residual review | `InMemoryReplayCache` retained every `jti` forever |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | The DPoP replay cache was an unbounded `HashSet<String>` of attacker-supplied `jti` values, so a long-running validator grew without limit — memory exhaustion from ordinary (valid) traffic | Entries carry a timestamp and expire after `DEFAULT_REPLAY_TTL_SECS` (300s); the validator now passes the request clock so pruning tracks the proof window |
| Medium | No capacity ceiling — with expiry alone a burst inside one window could still exhaust memory | `DEFAULT_REPLAY_CAPACITY` (100k) with fail-closed behavior: at capacity new proofs are rejected rather than evicting entries, since eviction would re-open the replay window |
| Low | `jti` length was unbounded and empty `jti` was accepted | Reject empty and anything over `MAX_JTI_LEN` (256) before storing |

Expiry is safe because `decode_dpop_proof` already rejects proofs whose `iat` is
older than `max_age_secs`, so a pruned `jti` cannot be replayed.

## Gate

```bash
cargo +1.88.0 clippy --workspace --all-targets -- -D warnings
cargo +1.88.0 test -p opensesame-proof
cargo +1.88.0 test --workspace --lib
```

---

## Original report: `2026-08-08-dpop-token-binding.md`

# Audit 2026-08-08 — proofs that were not bound to a token

Tick 74 read `packages/api-client`, the client the extension, the PWA, the MCP
client and the CLI all use to reach the Host API.

## The proof carried no `ath`

`createDpopProof` minted `jti`, `htm`, `htu` and `iat` and stopped there, while
`request` attached both the proof and `Authorization: Bearer <token>`. RFC 9449
§4.3 binds a proof to the token it accompanies with `ath`; without it the proof
attests to a key and a request but not to a credential, so a proof observed with
one token is a proof for any token on the same URL.

The verifier already asked for it: `crates/proof` returns
`AccessTokenHashMismatch` when it expects an `ath` and the proof has none, so
every DPoP-bound authenticated call from this client was also going to be refused.
Proofs now carry `ath` — `base64url(SHA-256(token))`, the same construction as
`access_token_hash` in the Rust crate — whenever a token is sent, and omit it when
none is, because an unexpected `ath` is rejected too.

## The bound URI included the query string

`htu` was the full request URL. RFC 9449 §4.2 binds scheme, authority and path;
`crates/proof::normalize_htu` drops the query on both sides, so nothing broke, but
a client should not put a caller-controlled query string inside a signed claim the
server then ignores. `htu` is now normalized before signing.

## The client exported a destination fence it did not apply to itself

`normalizeHttpBaseUrl` lives in this package and every careful caller — the
extension, the MCP client — remembered to run its base URL through it first. The
client itself took `baseUrl` verbatim and sent a bearer to it. `apps/pwa` passed
`VITE_HOST_API` straight through, so a build pointed at a cleartext remote host
handed the session token to the network.

`createApiClient` now applies the fence to its own `baseUrl` and refuses to be
built otherwise. The PWA reports the refusal once instead of failing every call.

Two related destinations were also taken on trust: `discover()` passed
`authorization_servers` from the resource metadata through as `string[]` — where a
client goes to be issued tokens, from a document that may not be trustworthy —
and `probeDaemon` would probe any URL handed to it. The first is now filtered
through the same fence, and the second is confined to loopback, since a daemon is
a process on this machine by definition.

## Not fixed here

- ~~DPoP server nonces are not implemented~~ — closed: the client remembers any
  `DPoP-Nonce` a server offers, includes it in later proofs, and retries exactly once
  when a 401 asks for one. A refusal that is not about the nonce is handed back
  untouched, and there is no loop.
- The proof key is generated per client instance and lives only in memory, so a
  reload is a new key. That is deliberate for these local-first surfaces, but it
  means nothing ties a session to a durable key.

---

## Original report: `2026-08-08-error-string-disclosure.md`

# Audit tick 38 — backend error strings in responses, redaction gaps

Scanners (cargo-audit, ast-grep, semgrep, cve-lite) were clean on `main`
(95f8f30). The findings come from tracing every `e.to_string()` that reaches an
HTTP body.

## 1. `GET /health/ready` echoed the backend error verbatim (unauthenticated)

`authority_quorum_ok()` failures were serialised straight into
`{"status":"not_ready","reason":…}` on a public, unauthenticated endpoint. A
connection failure carries the DSN — `postgres://user:password@host:5432/db` —
plus internal hostnames and ports. The endpoint now answers a stable
`authority_unavailable` code and logs the detail via `tracing::warn!`.

`/health/providers` (operator-gated since tick 25) now runs its OpenFGA /
OpenBao error strings through `redact_text` as well.

## 2. `redact_text` missed the shapes that actually carry secrets

The helper only rewrote `Bearer …`, `device_code=` and `refresh_token=`. It let
through DSN userinfo, `Basic` credentials, JSON `"client_secret":"…"`, and every
other labelled secret (`api_key=`, `user_code=`, `authorization: …`). Hardened
to:

- `scheme://user:pass@host` → `scheme://[REDACTED]@host` (covers the empty-user
  `redis://:pass@host` form).
- `Basic <b64>` alongside `Bearer <token>`.
- Any `label=value` / `label: value` / `"label":"value"` where the label matches
  the secret vocabulary, quote-aware so JSON fragments are censored too.

Innocuous text is left untouched (`authority quorum degraded: 1 of 3 nodes
reachable` round-trips unchanged).

## 3. Gateway invoke / receipt verify leaked upstream detail

- `POST /v1/intents` returned `openfga_unavailable: {e}`; a reqwest transport
  error can embed the store URL and its bearer. Now a bare code, detail logged.
- Parameter-canonicalisation errors and `receipts/{id}/verify` failures now go
  through `redact_text`.

## 4. Identity plane advertised the Host API address

`POST /v1/device/approve` echoed `forwarded_to: <hostApiUrl>` on every response
and `detail: <fetch error>` on failure, handing any authenticated caller —
including a provisional one — the internal Host API host/port and connection
diagnostics. Both fields are gone; the failure is logged through `ctx.log`.

Tests: five new cases in `crates/redaction` (DSN, labelled values, `Basic`,
JSON, no-op). `cargo test --workspace`, `npm run test:all`, `npm run typecheck`, clippy and `cargo fmt --check` are clean.

---

## Original report: `2026-08-08-extension-host-fence.md`

# Security audit — extension Host API loopback fence — 2026-08-08

Branch: `chore/audit-tick30`

## Scanners

| Check | Result |
|------|--------|
| ast-grep / semgrep | CLEAN |
| battle-test / task-security-battle-test | CLEAN |
| Residual review | Browser extension used stored `hostApiBase` verbatim |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | The popup wrote any string to `chrome.storage.local.hostApiBase` and the background service worker used it verbatim as the API base, so a rewritten value could repoint the extension at a remote Host API (or a credential-bearing URL) | New `normalizeLoopbackBaseUrl` in `@opensesame/api-client`; popup rejects non-loopback input with a hint and background falls back to `http://127.0.0.1:8787` |
| Build | `wxt build` failed on `main` — esbuild refuses the DPoP `const { kty, crv, x, y } = jwk` destructuring at the extension's `firefox78` target, so the extension could not be built at all | Explicit property reads in `createDpopKeyPair` |

The fence matches the daemon/gateway bind policy: loopback only, no credentials
in the URL, no query/fragment smuggling. `host_permissions` already limited
network reach to loopback; this closes the config path that pointed elsewhere.

## Gate

```bash
npm run test -w @opensesame/api-client
npm run typecheck -w @opensesame/api-client
npm run build -w @opensesame/browser-extension
./scripts/test/battle-test.sh
```

---

## Original report: `2026-08-08-frozen-intent-custody.md`

# Audit — frozen intent custody and ceiling storage (2026-08-08)

Tick 56. Scope: `crates/task-access` (engine, SQLite store, Postgres store) and
the task routes in `crates/gateway/src/routes/tasks.rs`.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | `invoke_task` removed the frozen intent from the pending map *before* checking who owned it. Anyone who learned a digest could spend another principal's intent, take a 404 for it, and leave the owner with nothing to invoke — the intent was already gone. | `claim_frozen_intent` settles ownership under the same lock and only then removes. Absent and not-owned return the same answer, so the endpoint still says nothing about other principals' work. |
| Low | The Postgres `task_runs` upsert set `capability_ceiling = EXCLUDED.capability_ceiling`, so a non-CAS `save_run` could widen the ceiling of a live run. The SQLite store already left the column alone; the two backends disagreed, and Postgres was the looser one. | The ceiling and its digest are excluded from the conflict update, matching SQLite and ADR 0019. |
| Low | `save_ceiling_digest` was a blind overwrite in all three stores, so the immutable ceiling was immutable only because the read path noticed. | Write-once in the in-memory, SQLite and Postgres stores: the same digest is accepted again, a different one is `CeilingImmutable`. |
| Low | The Postgres store inserted an empty `ceiling_digest` and relied on a second call to fill it, so a crash between the two left a row that failed every later ceiling check. | The digest is derived on insert, as SQLite already did. |

## Notes

- `save_run` is only reached from `start_task`; every later write goes through
  `save_run_cas`, which never touched the ceiling. Excluding the ceiling from the
  upsert therefore removes a capability nothing legitimately used.
- The engine's read-path check (`assert_ceiling_unchanged`) is unchanged and
  still runs before every capability assertion and transition. These fixes mean
  it is no longer the only thing standing between a stray writer and a wider
  ceiling.
- Cross-tenant reads were checked and are fenced: `list_tasks`, `get_task`,
  `freeze_intent` and `terminate_task` all filter on `caller.owns`.

## Gates

`cargo test --workspace` (70 suites), `cargo clippy --workspace --all-targets --
-D warnings`, `npm test`, `npm run typecheck`, task-security-battle-test,
cargo-audit, cargo-deny, semgrep, ast-grep, osv-scanner, gitleaks, cve-lite —
all clean.

---

## Original report: `2026-08-08-frozen-intent-enforcement.md`

# Audit tick 43 — frozen intents were advisory, not enforced

Date: 2026-08-08
Scanners: cve-lite, gitleaks, semgrep, security battle test, clippy, cargo-audit, osv-scanner, cargo-deny, ast-grep

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | The task-bound execution path did not exist. `POST /api/v1/tasks/intents` froze an intent, returned a digest, and forgot it; the MCP host and daemon then executed through `POST /api/v1/intents`, which builds an intent from the request body and never reads `task_run_id` or `intent_digest`. No capability was asserted, no ceiling consulted, no state version checked — an agent could freeze `read` on `doc:1` and then execute anything the demo grant allowed, with a receipt carrying no task provenance. | Frozen intents are now held server-side and executed by digest at `POST /api/v1/tasks/invoke`, which routes through `Broker::invoke_frozen` (recomputes the digest, asserts the capability, checks the task state version, and verifies the ceiling is unchanged). Digests are single-use and expire with the intent. |
| High | `operator_invoke_l1` (MCP host) let the model override `operation` and `resource` while still presenting the frozen intent's digest — one call executed, another call's digest attested. | The tool takes only `connection_ref`; operation, resource, and arguments come from the frozen intent, and the daemon forwards the digest to the fenced route. |
| Medium | `POST /api/v1/intents` silently ignored `task_run_id` / `intent_digest`, so a task-bound caller looked fenced while spending no ceiling. | The route refuses those fields (in body or headers) with `task_authority_requires_frozen_invoke`, naming the freeze/invoke pair. |
| Low | The daemon echoed the reqwest transport error, which carries the Host API address. | Log it, answer `host_api_unreachable`. |

## Notes

- `SharedTaskEngine` dropped its outer `Mutex`: `InMemoryTaskStore` already synchronizes
  itself, and a `std` guard cannot be held across the `.await` in the invoke path.
- Server-side custody is the point. If the caller restated the frozen fields at execution
  time, the digest would only prove it can hash, so the pending map is the enforcement
  boundary — bounded at 512 entries and pruned by the five-minute intent expiry.
- Ownership is checked before the digest is spent: another principal's frozen intent
  answers 404, not 403, so digests are not an existence oracle.

## Verification

- `cargo clippy --workspace --all-targets --all-features` — clean
- `cargo test --workspace` — clean (new `claims_task_authority` unit tests)
- `npm run test` -w @opensesame/mcp-host — clean
- semgrep, gitleaks, cve-lite, security battle test — clean

---

## Original report: `2026-08-08-grant-covers-intent.md`

# Audit tick 63 — a grant covers what it was narrowed to

Scanners (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit, cargo-deny, clippy,
task-security-battle-test) were clean. The reading was `crates/broker`'s frozen
invoke path and `crates/authz`'s decision function.

## The frozen invoke path ignored every narrowing field on the grant (fixed)

`Broker::invoke_frozen` compared the intent's organization to the grant's and
stopped there. `AuthzEngine::decide` then checked the grant's actions, resources,
audience, and required assurance. Nothing anywhere compared the grant's

- `beneficiary_principal_id`,
- `project_id`, `actor_id`, `actor_instance_id`, `client_id`, `connection_id`

against the intent. A grant issued to one principal, for one agent, one project
and one connection therefore authorized any intent in that organization whose
action, resource and audience happened to fit — which is precisely what those
fields exist to forbid (ADR 0027, one effective authority).

`assert_grant_covers_intent` now runs before authorization. `None` on the grant
means unscoped in that dimension; `Some` means the intent must name the same
thing. An intent that names nothing does not satisfy a grant that names
something — reading it the other way is how a scoped grant quietly became an
unscoped one.

## The intent named an actor that did not exist (fixed)

`POST /api/v1/tasks/intents` stamped every frozen intent with a fresh
`ActorId::new()`, no connection, and whatever project the task run carried
(always `None`). The receipt's actor was therefore meaningless, and no grant
narrowed to an actor or a connection could tell whether it covered the call.

Freezing now stamps the intent with the authority the invoke actually executes
under — the bootstrap actor, connection, and project — so the bindings above are
satisfied by naming the right thing rather than by naming nothing.

## Read and left alone

- The digest is recomputed and re-asserted before execution, execution reads only
  `canonical_arguments`, and the task state version, state digest, and ceiling
  digest are all re-checked at invoke.
- Idempotency returns the prior receipt rather than re-executing.
- The demo bootstrap grant remains the only grant available to this path, so
  bounding `start_task` ceilings against issued grants is still open — it needs a
  grant issuance path for ordinary principals.

---

## Original report: `2026-08-08-grant-resource-scope.md`

# Audit tick 51 — a grant's resource scope was decorative

Date: 2026-08-08
Scanners: cargo-audit, cve-lite, semgrep, ast-grep, osv-scanner, gitleaks, cargo-deny, clippy, security battle test

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `PolicyEngine::decide` checked `grant.actions` but never `grant.resources`, so a grant scoped to `repo:acme/catalog` authorized the same action against any resource the relationship check happened to allow. Half of every issued grant was unenforced. | `Grant::permits_resource` is now consulted for `connector_operation` requests — the invoke path the broker uses. Wildcards keep their separator (`repo:acme/*` cannot reach `repo:acme-private/…`), an exact name cannot reach a longer sibling, and an empty resource list covers nothing. |
| Medium | `authorize_authority_use` relabelled its request as a `connector_operation` with the placeholder id `"op"` before calling the engine. With the check above in place, that placeholder would have satisfied a grant's resource scope on the strength of a resource nobody named. | The request stays `connection`-scoped and the engine gained a matching relationship branch. On that path the target is the URL, already fenced by `EgressBinding::allows_url`. |

## Notes

- Three existing tests failed the moment the check was added, all because their
  fixtures requested resources their grants never named. They passed only because
  nothing looked. Two were corrected to use the granted resource, and a negative
  case was added alongside: same subject, same granted action, a resource outside
  the grant, denied with reason `grant_resource`.
- Follow-up, not fixed here: `authorize_authority_use` still overwrites the action
  with `grant.actions.first()`, so the grant's action list does not constrain an
  authority use either. Fixing it means grants must name `connection.fetch` /
  `connection.invoke`, which is a data-model change rather than an audit fix.
- Follow-up, still blocked: `start_task` accepts a self-declared capability list.
  Bounding it against issued grants needs a grant issuance path for ordinary
  principals — today only the dev bootstrap creates grants, so enforcing it now
  would refuse every real caller.

## Verification

- `cargo test -p opensesame-domain` — resource scope boundaries covered (new test)
- `cargo test -p opensesame-authz` — 15 passed, including the new denial case
- `cargo test --workspace` — 0 failures
- `cargo clippy --workspace --all-targets -- -D warnings` — clean
- cargo-audit, cargo-deny, osv-scanner, semgrep, gitleaks, cve-lite, ast-grep — clean

---

## Original report: `2026-08-08-idempotency-and-claim-consent.md`

# Audit tick 41 — idempotency replay across principals, claim consent proof

Scanners (gitleaks, cargo-deny, osv-scanner, semgrep, task-security-battle-test)
were clean on `main` (a339368). Both findings are in the Identity plane.

## 1. Idempotency cache handed one principal's response to another

The cache key was `${scope}:${method}:${path}:${key}` — the client-chosen
`Idempotency-Key` with no caller in it. The cached bodies are exactly the
credential-bearing ones: `POST /v1/agents` returns a claim token, `/v1/oauth/clients`
a client secret, `/v1/projects/temporary` a claim token, and
`POST /v1/principals/provisional` returns a `pst_…` access token — whose
`Set-Cookie` the middleware deliberately replayed as well. Reusing a victim's
key (ours are strings like `signup-1`) returned their response verbatim.

Fix:

- Entries are keyed by the authenticated principal.
- Anonymous callers are never cached: there is no identity to bind an entry to,
  so provisional signup now always mints a fresh principal.
- No header replay at all — re-issuing `Set-Cookie` to a different HTTP client
  is never correct.
- Entries carry a 10-minute TTL, the store is capped at 2048 entries, and keys
  longer than 255 chars are ignored (the key was client-controlled and the map
  previously unbounded).

Tests: cross-principal replay returns a distinct agent and claim token while the
owner still gets `Idempotency-Replayed: true`; two anonymous signups with the
same key produce different principals and tokens.

## 2. Claim approval required no proof of consent

`POST /v1/claims/{id}/complete` accepted *any* authenticated principal plus the
claim id. It drives `presented → authenticated → reviewed → completed`, and
completion activates the referenced project and flips an agent to `claimed`. The
`userCodeDigest` minted with every claim — the whole point of the code the device
displays — was never verified (`verifyUserCode` was dead code). So a bystander
principal who learned a claim id could approve someone else's ceremony.

Fix: `userCode` is now a required field on `CompleteClaimRequest`, verified
against `session.userCodeDigest` with the existing constant-time helper, behind a
five-attempt per-claim fence (`429 too_many_attempts`). OpenAPI documents the
body and the new 401/429 answers; the daemon's Identity-API fallback forwards a
`user_code` (and refuses without one) instead of posting an empty body.

---

## Original report: `2026-08-08-identity-link-assurance.md`

# Audit tick 36 — self-asserted identity links promoted principals to `verified`

Date: 2026-08-08
Scope: `apps/control-plane/src/routes/principals.ts`

## Scanners

| Check | Result |
|-------|--------|
| semgrep (ERROR+) | CLEAN |
| ast-grep | CLEAN |
| cargo-audit (379 crates) | CLEAN |
| cve-lite | CLEAN |
| Residual review | `link-identities` trusted the caller's identity assertion and leaked the bound principal id |

## Findings fixed

### 1. Assurance escalation via `POST /v1/principals/link-identities` (high)

The route took `kind`, `issuer`, `subject` and `assurance` straight from the
request body. Nothing in the request proves the caller controls that upstream
identity — and on success a provisional principal was promoted:

```ts
state: "active",
assurance: parsed.data.assurance === "provisional" ? "verified" : parsed.data.assurance,
verifiedAt: now,
```

So any anonymous caller could mint a provisional principal, POST
`{issuer: "https://accounts.example", subject: "anything", assurance: "verified"}`,
and become `verified` — which is exactly the gate that gutted-by-design checks
rely on for creating organizations, projects and OAuth client registrations (and,
after tick 35, for mutating clients). Unlike the stub TOTP factor and the stub
passkey path, this seam had no dev gate at all.

Fix: the route now requires `ctx.config.allowDevDefaults`, mirroring
`/v1/mfa/totp/enroll`. Outside dev it answers `403
identity_link_requires_upstream`, so a real deployment must complete an upstream
authentication ceremony before an identity can be bound.

### 2. Collision response disclosed the bound principal id (low)

The `409 identity_collision` body echoed `boundPrincipalId`, letting any caller
probe an upstream identity tuple and learn which principal owns it. The field is
removed (it had no consumers anywhere in the repo).

## Verification

- `npm run test` -w @opensesame/control-plane — new case asserts the 403 in
  non-dev config, that the principal stays `provisional`, and that a dev-mode
  collision response does not contain the other principal's id.
- `npm run test:all` and `npm run build` green.

---

## Original report: `2026-08-08-issuer-persistence-and-worker.md`

# Audit 2026-08-08 — issuer persistence, and a worker that admitted what it does

Two long-standing follow-ups: the OIDC provider ran on the in-memory adapter in
every deployment, and the standalone cleanup worker reported healthy ticks while
expiring nothing.

## 1. The issuer kept its own models in memory (tick 34)

`createOpenSesameProvider` has taken an adapter since it was written, and
`createPostgresAdapterConstructor` has been waiting for a store. Nothing
implemented one, so the control plane ran the provider on `MemoryAdapter` whatever
`DATABASE_URL` said. In that shape every restart invalidates live sessions and
refresh tokens, and a consumed authorization code stops being remembered as
consumed — the record it would be recognised by is gone with the process.

`createPostgresOidcStore` (in `packages/database`) backs the adapter with an
`oidc_payloads` table (migration `0004_oidc_payloads.sql`), and `createControlPlane`
wires it whenever a database is configured. Two rules are worth naming:

- An expired row is never returned. A token that outlived its TTL must not be
  honoured because a cleanup job has not run yet.
- `consume` stamps the row instead of deleting it. The provider decides what a
  replayed authorization code means, and it has to see a consumed code rather than
  a missing one to say "already redeemed" instead of "never existed".

Signing keys already resolve from `jwks` or `OPENSESAME_JWKS_JSON`, and
`createOpenSesameProvider` refuses an ephemeral per-process keypair in production,
so there was nothing left to wire there — the follow-up's other half was already
closed.

## 2. The standalone worker enforced nothing and said nothing (tick 53)

Claims, provisional sessions and temporary projects live in the control plane's
process. The standalone worker was handed empty maps for all three, so it logged a
successful tick every interval while inspecting nothing. That is worse than not
running it: an operator watching healthy ticks concludes TTLs are being enforced.

Those dependencies are now optional, a tick reports `expiryEnforced`, and the
standalone entrypoint logs at start that it publishes the outbox and that expiry
runs in-process in the control plane. Sharing the state properly still means
moving provisional sessions and projects behind repositories, which is the design
change this note has been deferring — but it no longer claims to have happened.

## Not fixed here

- Provisional sessions and temporary projects still have no repository, so their
  expiry is only enforced where the maps live.
- ~~`oidc_payloads` rows past their TTL are refused on read but only removed by
  `pruneExpired`, which nothing calls on a schedule yet.~~ — closed: the cleanup
  tick prunes them every interval, and the standalone worker now constructs the
  store to do it.

## Verification

- `packages/database`: 4 new tests (lookup-key extraction, TTL refusal, consumed
  stamp, no mutation of the stored payload) — 9 total
- `apps/worker`: 1 new test (a tick with no state says so) — 4 total
- `npm run -r typecheck`, full workspace tests green

---

## Original report: `2026-08-08-legacy-credential-agent.md`

# Audit tick 44 — the deprecated credential agent was an unauthenticated daemon

Date: 2026-08-08
Scanners: cargo-audit, osv-scanner, ast-grep, cve-lite, clippy, semgrep, gitleaks, cargo-deny, security battle test

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `apps/credential-agent` — marked deprecated, still built and documented — served `/v1/list_sessions`, `/v1/mint_capability`, `/v1/introspect_capability`, and `/v1/revoke` with no authentication at all. The daemon that replaced it fences the same routes behind an operator bearer, so any co-resident process could skip the daemon, enumerate host sessions and their principals, mint itself a 30-minute session capability, or revoke someone else's. Loopback is not a boundary in this threat model — it is why the daemon has an operator token and a UDS-only mode. | Every `/v1/*` route now requires the operator bearer, and the process refuses to start unless `OPENSESAME_LEGACY_CREDENTIAL_AGENT=1` is set, so a stray build cannot quietly offer a second privileged local API. |
| Medium | The capability map grew without bound and never dropped expired entries, so an unauthenticated mint loop was also a memory sink. | Prune on mint and cap at 1024 live capabilities. |
| Low | `constant_time_eq` and the operator header parsing were copied per binary, so a fix in one did not reach the others. | Moved to `opensesame_host_core::operator` (`check`, `token_from_headers`, `constant_time_eq`) with unit tests; the daemon now uses it. |

## Notes

- `check` returns `Unconfigured` distinctly from `Unauthorized`: an unset token must
  deny (503) rather than compare against an empty secret and let everything through.
- Follow-up from tick 43 closed: `opensesame intent invoke --digest …` spends a frozen
  intent through the fenced Host API route, so the CLI can drive the whole freeze →
  execute path.

## Verification

- `cargo clippy --workspace --all-targets --all-features` — clean
- `cargo test --workspace` — clean (new `host_core::operator` tests)
- semgrep, gitleaks, cargo-audit, osv-scanner, cargo-deny, cve-lite, ast-grep — clean
- `npm run test:task-access`, `npm run test:security` — clean

---

## Original report: `2026-08-08-live-quotas-mfa-fences.md`

# Audit tick 48 — lifetime quotas, unfenced MFA verification

Date: 2026-08-08
Scanners: cargo-audit, cve-lite, semgrep, ast-grep, osv-scanner, gitleaks, cargo-deny, clippy, security battle test

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | Quota usage was a running counter that only ever went up, so the provisional cap was a lifetime cap: three temporary projects and the principal was blocked forever, even after all three had lapsed. Legitimate users lock themselves out, and the natural workaround is a second anonymous principal — which defeats the quota it was meant to enforce. | `getUsage` counts live projects and agents from the stores (owner match, live state, not past `expiresAt`), so an expired project returns its slot. The counter survives only for temporary resources, which have no store to count. |
| Medium | `POST /v1/mfa/totp/verify` had no attempt fence, so a six-digit code was 10^6 guesses at whatever rate the caller managed. `POST /v1/mfa/passkey/assert` was likewise unlimited and unauthenticated. | Five failures per subject (`totp:<principal>`, `passkey:<credentialId>`) then 429; a success clears the count. |
| Medium | `createMemoryChallengeStore` never pruned: every issued WebAuthn challenge stayed in memory whether or not it came back, so an authenticated loop over `/passkey/authentication-options` grew the map without limit. | Expired rows are dropped on each write and the store caps at 4096 outstanding challenges, evicting the oldest. |

## Notes

- Live counting deliberately treats `suspended` agents and `provisional`/`active`
  projects as occupying a slot; only expiry, deletion, or revocation frees one.
- The TOTP fence closes even against the correct code — a locked fence that a correct
  guess reopens is not a fence. It is per-principal and in-memory, matching the
  claim-approval fence from tick 41.

## Verification

- `npm run test` -w @opensesame/control-plane — 30 passed (3 new)
- `npm run test` -w @opensesame/auth-upstream — 12 passed (1 new)
- `npm run typecheck`, `npm test`, `cargo test --workspace`, clippy — clean
- cargo-audit, osv-scanner, cargo-deny, semgrep, gitleaks, cve-lite, ast-grep — clean

---

## Original report: `2026-08-08-log-redaction-depth.md`

# Audit tick 32 — structured log redaction only reached one level deep

Date: 2026-08-08
Scope: `packages/observability`

## Finding (medium — credential disclosure in diagnostics)

`createLogger` relied entirely on pino's `redact.paths`. Pino's `*` wildcard
matches exactly one level, so the configured `*.access_token` / `*.token`
entries covered `{ outer: { token } }` but **not** anything deeper. Reproduced
before the fix:

```
log.info({ ctx: { session: { access_token: "LEAKED-DEEP" } }, outer: { token: "x" } });
=> {"ctx":{"session":{"access_token":"LEAKED-DEEP"}},"outer":{"token":"[Redacted]"}}
```

Nested request/session context is exactly how bearer tokens, claim tokens,
device/user codes and sync ciphertext travel through this codebase, so a single
`log.info({ ctx })` in the control plane or worker could write live credentials
to disk or a log shipper. Audit events were unaffected (`packages/audit` uses a
key allowlist), this was diagnostic logging only — the split ADR 0015 draws.

## Fix

- Added `SENSITIVE_KEY_PATTERN` (tokens, codes, secrets, passwords, private
  keys, DPoP proofs, ciphertext) and `redactDeep`, a depth-limited, cycle-safe,
  array-aware walk that censors matching keys at **any** depth.
- Wired `redactDeep` in as pino's `formatters.log` so every merged log object
  passes through it; `redact.paths` is kept for `req`/`res` header paths.
- Depth ceiling of 12 and a `WeakSet` cycle guard keep a hostile or self
  referential object from stalling the logger; non-plain objects (Error, Date,
  Buffer) are left to pino's serializers.

## Also fixed this tick — `npm run build` was red on `main`

`apps/console`, `apps/pwa`, `apps/mobile-mfa`, `examples/rp-alpha` and
`examples/rp-beta` had no `build.target`, so Vite used its legacy default
set and esbuild 0.28 aborted on ordinary `const [a, b] = useState()` forms.
All five now carry the same modern target `apps/pages` already documented
(`es2022`/`chrome100`/`firefox100`/`safari15`). Workspace build: 14/14 green.

## Verification

- `npm run test` -w @opensesame/observability — deep nesting, arrays and
  cycles covered by new cases.
- `npm run test`, -w @opensesame/control-plane `--filter @opensesame/worker
  test`, `--filter @opensesame/audit test` — consumers unchanged.
- Scanner rotation (ast-grep, semgrep, osv-scanner) clean this tick.

---

## Original report: `2026-08-08-mcp-agent-boundary.md`

# Audit 2026-08-08 — what the MCP host hands back to the model

Date: 2026-08-08
Scanners: cve-lite, osv-scanner, cargo-audit, cargo-deny, gitleaks, semgrep,
ast-grep, clippy, task-security-battle-test — all clean. This came from reading
`apps/mcp-host`.

## Finding

| Severity | Finding | Fix |
| --- | --- | --- |
| High | Every tool relayed the Host API or daemon response body to the model verbatim (`textContent(JSON.stringify(body))`). This process is the one holding `OPENSESAME_OPERATOR_TOKEN`, so anything upstream that echoed what it received — a 401 quoting the Authorization header, a validation error printing the request, a debug field — put the machine's operator secret into the model's context. A model that reads that token no longer needs the tools; it can call the daemon directly. | New `forAgent` fence on every relayed payload, plus `scrubLocalSecrets` on tool error text. |

The catalog check that already existed (`assertsNoSecretTools`) covers tool *names*.
Nothing covered tool *output*, even though the Rust host enforces exactly that at
the same boundary with `assert_no_secret_in_agent_payload`.

## What the fence does

Two different jobs, in this order:

- **Secrets this process holds are scrubbed by value.** No pattern guessing and no
  false positives: `OPENSESAME_OPERATOR_TOKEN`, `OPENSESAME_ACCESS_TOKEN` (with and
  without its `opaque-session:` prefix, since `hostAuthHeaders` accepts either) and
  `OPENSESAME_CLAIM_PEPPER` are replaced with `[REDACTED]` wherever they appear.
  Values under 8 characters are ignored — a two-character "secret" would scrub half
  the payload for no gain.
- **Payloads still carrying credential shape are refused.** `secret://`,
  `bearer operator:`, `client_secret`, `refresh_token`, `access_token`,
  `private_key`, `-----BEGIN`, `ghp_` — the same list the Rust host uses, so both
  boundaries agree on what a secret looks like. Nothing these tools legitimately
  return contains one, so its presence means the response is not what we think it
  is, and the model gets a refusal rather than a redaction.

Scrubbing runs first deliberately. A body whose only offence was quoting our own
token is perfectly usable once the token is gone, and refusing it would turn a leak
into an outage.

## Not fixed here

- The fence sees text, not intent. A secret an upstream service invented a new name
  for is not on the marker list, and only the by-value scrub is exhaustive — for
  secrets this process happens to hold.
- `hostFetch` still concatenates a caller-supplied path onto the base URL. Every
  call site interpolates ids through `encodeURIComponent`, so nothing traverses
  today, but the helper does not enforce it.

## Verification

- `apps/mcp-host` — 13 passed (3 new: token echo scrubbed, credential-shaped
  payloads refused, echo preferred scrubbed over refused)
- `npm run -r typecheck`, full workspace tests — green
- cve-lite, osv-scanner, cargo-audit, cargo-deny, gitleaks, semgrep, ast-grep,
  clippy, task-security-battle-test — clean

---

## Original report: `2026-08-08-mcp-endpoint-fences.md`

# Audit tick 52 — MCP servers aimed by their environment

Date: 2026-08-08
Scanners: cargo-audit, cve-lite, semgrep, ast-grep, osv-scanner, gitleaks, cargo-deny, clippy, security battle test

An MCP server's environment is routinely supplied by whatever project the agent has
open, so an unchecked base URL is a way to aim a local secret at a remote listener.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `mcp-host` took `OPENSESAME_SERVER` / `OPENSESAME_HOST_API` / `OPENSESAME_DAEMON_URL` verbatim and attached `Bearer operator:<token>` to whatever they named. A base URL pointing anywhere sent the local operator secret — the credential that authorizes device approval, claim completion and L1 invoke — to that host in cleartext. | Base URLs are normalized and refused unless https or loopback; embedded credentials are rejected. The operator bearer is offered only to a loopback target, and the daemon must be loopback outright. |
| Medium | `mcp-client` took `OPENSESAME_HOST_API` and `OPENSESAME_ISSUER` verbatim while sending the session bearer on every call, so plain `http://` to a remote host leaked the session to the network. | Both are validated at startup with a shared `normalizeHttpBaseUrl` (https anywhere, http only on loopback), failing before the first call rather than on it. |
| Medium | `daemonFetch` sent no `Authorization` at all, but every daemon `/v1/*` route requires the operator bearer, so `operator_invoke_l1` and `daemon_status` could only ever answer 401 — the fenced frozen-intent path from tick 43 was unreachable from MCP. | The daemon bearer is attached (loopback-enforced), making the tool work as documented. |

## Notes

- `normalizeLoopbackBaseUrl` only accepted `127.0.0.1`; it now covers all of
  127.0.0.0/8, which the loopback interface actually answers for.
- A remote Host API is still supported — it just has to be https and is reached with
  a session bearer, never the operator secret.

## Verification

- `npm run test` -w @opensesame/mcp-host — 8 passed (3 new: base refusal, operator
  token withheld from remote, daemon auth + loopback)
- `npm run test` -w @opensesame/api-client — 8 passed (1 new)
- `npm run typecheck`, `npm test` — clean
- semgrep, gitleaks, cargo-audit, cargo-deny, osv-scanner, cve-lite, ast-grep — clean

---

## Original report: `2026-08-08-mcp-resource-scope.md`

# Audit tick 60 — a resource is not an origin

Scanners (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit, cargo-deny, clippy,
task-security-battle-test) were clean. The reading was `crates/protocol-mcp`,
`crates/protocol-aauth`, and `crates/authn`.

## An origin standing in for a resource (fixed)

`validate_resource_uri` compared the request URI to the protected resource's
audience by scheme, host, and port, and dropped the path. An audience is a
resource indicator (RFC 8707) and is routinely path-scoped — one host serving one
MCP server per tenant, `https://mcp.example/tenant-a`. Under the origin-only
reading a token minted for tenant-a's resource passed the resource check for a
request to tenant-b.

The check now confines a path-scoped audience to its path, at segment boundaries,
so `/tenant-attacker` cannot pass as `/tenant-a`. `crates/authn`'s
`validate_verification_uri_complete` already read paths this way; the two
neighbouring checks now agree. A request URI carrying userinfo is refused as well:
`https://mcp.example@evil.test/` names evil.test, not the resource.

Nothing calls this function outside its tests yet, so this is a fix ahead of the
wiring rather than a live exposure.

## Pinned rather than changed

The scope mappings in both protocol crates are stubs that cannot name a resource,
so they ask for the literal `*`. Selectors are literal (`ResourceSelector` has no
wildcard), which makes that request fail closed against any ceiling confined to
real resources — the safe reading, but an accidental one. Both crates now have a
test that says so, so the stub cannot quietly become permissive when the drafts
settle.

## Read and left alone

- `crates/authn`: device-flow polling, PKCE S256, and the verification-URI origin
  check are all sound; `validate_audience` is an exact match, which is right.
- `crates/gateway/src/routes/aauth.rs` `scope_check` takes the ceiling from the
  request body, but it is advisory (behind the experimental flag and a session or
  operator bearer) and grants nothing.
- Interpolated Host API paths in `apps/mcp-host` are percent-encoded.

## Note for the loop, not the repo

A `cargo test --workspace` run in this worktree failed to compile against a stale
`opensesame-task-access` rmeta from a sibling worktree, because both shared one
`CARGO_TARGET_DIR`. The audit worktree now builds into its own target directory;
the workspace is clean under it.

---

## Original report: `2026-08-08-oauth-client-ownership.md`

# Audit tick 35 — OAuth client registrations had no owner

Date: 2026-08-08
Scope: `apps/control-plane/src/routes/oauth-clients.ts`, `packages/contracts`,
`packages/os-domain`, `packages/database`

## Scanners

| Check | Result |
|-------|--------|
| osv-scanner | CLEAN |
| gitleaks (working tree) | CLEAN |
| cargo-deny | ok |
| clippy `--workspace --all-targets --all-features` | CLEAN |
| Residual review | oauth client routes had no ownership check; redirect URI validation accepted dangerous schemes |

## Findings fixed

### 1. Any verified principal could take over any OAuth client (high)

`OAuthClientRecord` carried no owner at all, and the routes looked clients up by
id alone. Every sibling resource in this app already scopes by owner
(`organizations` filters on `createdBy`, projects/agents carry
`ownerPrincipalId`) — OAuth clients were the outlier. Consequences for any
authenticated principal:

- `GET /v1/oauth/clients` listed **every** client in the deployment.
- `PATCH /v1/oauth/clients/{id}` could repoint another client's `redirectUris`
  at an attacker-controlled host — authorization-code interception, i.e. account
  takeover of that client's users — and rewrite its `allowedScopes` /
  `allowedResources`.
- `POST /{id}/rotate` and `POST /{id}/revoke` could break any client at will.

Additionally the `assurance !== "provisional"` gate existed only on create, so a
provisional principal could still mutate clients.

Fix: `ownerPrincipalId` is now part of the record (domain type, response
contract, and the `oauth_clients` table via migration `0001`), stamped on create.
Reads and mutations go through `loadOwnedClient`, which answers 404 for foreign
or unknown ids alike so the route is not an existence oracle. `assertVerified`
now guards patch/rotate/revoke as well as create.

### 2. `redirectUris` accepted `javascript:`, `data:` and `file:` URLs (high)

`z.string().url()` only checks that `new URL()` parses, which admits
`javascript:alert(1)`, `data:text/html,…`, `file:///etc/passwd`, URLs with
fragments, and URLs with embedded credentials — verified against the installed
zod. A registered `javascript:` redirect URI turns the authorization redirect
into script execution in the authorization server's own redirect context.

Fix: `RedirectUriSchema` / `isAllowedRedirectUri` accept only https, http on
loopback (RFC 8252 native-app development), and reverse-DNS private-use schemes
(`com.example.app:/cb`), and reject fragments (RFC 6749 §3.1.2) and embedded
credentials. Applied to both create and patch.

## Verification

- `npm run test` -w @opensesame/control-plane — new test proves a second
  principal cannot list, repoint, rotate or revoke another's client, that the
  owner still can, and that `javascript:` is refused with 400.
- `npm run test` -w @opensesame/contracts — scheme allow/deny table.
- `npm run test:all` green across 22 packages; `npm run build` 14/14.
- `npm run db:generate` -w @opensesame/database → `0001_yielding_wildside.sql`
  (nullable column + FK + index; no backfill needed since the control plane
  keeps clients in memory today).

---

## Original report: `2026-08-08-oauth-provider-fail-closed.md`

# Audit tick 34 — OAuth provider minted tokens for any audience and any key

Date: 2026-08-08
Scope: `packages/oauth-provider`

## Scanners

| Check | Result |
|-------|--------|
| cve-lite (overrides) | CLEAN (1 PD002 monorepo false positive) |
| semgrep (ERROR+) | CLEAN |
| ast-grep | CLEAN |
| `scripts/test/task-security-battle-test.sh` | OK |
| `scripts/test/battle-test.sh` | ALL PASSED |
| Residual review | provider config accepted any resource indicator; production silently ran on ephemeral keys + memory state |

## Findings fixed

### 1. Any client could get a JWT audienced to any resource server (high)

`resourceIndicators.getResourceServerInfo` echoed whatever `resource` the client
asked for straight back as the token `audience`, with `accessTokenFormat: "jwt"`:

```ts
getResourceServerInfo: async (_ctx, resourceIndicator) => ({
  scope: "openid",
  audience: resourceIndicator,   // ← attacker-chosen
  accessTokenFormat: "jwt",
})
```

So any admitted client could obtain a signed JWT with `aud` set to an arbitrary
resource server — the exact audience confusion RFC 8707 resource indicators exist
to prevent, and a laundering path into any RS that trusts this issuer. Note that
`OAuthClientRecord.allowedResources` already existed in the type model; the
runtime simply never consulted any allowlist.

Fix: `canonicalResource` normalizes indicators (absolute `http(s)` URI, no
query/fragment, lower-cased scheme + host, no trailing slash) and
`isResourceAllowed` checks them against `OPENSESAME_ALLOWED_RESOURCES`. With no
allowlist configured the only acceptable audience is the issuer itself — never
"whatever was requested". Rejections raise `errors.InvalidTarget`
(`invalid_target`). Look-alike hosts and deeper paths under an allowed prefix are
rejected, since matching is on the whole canonical form.

### 2. Production silently ran on an ephemeral keypair and in-memory grants (high)

`buildJwks()` generated a fresh RSA key **per process** whenever no `jwks` was
passed, and the adapter defaulted to `MemoryAdapter`. `apps/control-plane`
passes neither, so a production deployment would: sign tokens with keys no other
replica can verify, invalidate every token on restart, and keep grants/sessions
per-process — meaning revocation and device-code state do not hold across
instances.

Fix: `createOpenSesameProvider` now resolves keys as `jwks` option →
`OPENSESAME_JWKS_JSON` → dev keypair, and throws in production if it would reach
the dev keypair or the memory adapter. Malformed `OPENSESAME_JWKS_JSON` is
rejected rather than ignored. The production seam already exists
(`createPostgresAdapterConstructor`); it now has to be wired instead of being
silently skipped.

## Follow-up

~~`apps/control-plane/src/create-app.ts` still constructs the provider without a
`jwks` or adapter~~ — closed in `2026-08-08-issuer-persistence-and-worker.md`:
`createPostgresOidcStore` backs the adapter and the control plane wires it whenever
a database is configured. Signing keys already came from `OPENSESAME_JWKS_JSON`
with production refusing an ephemeral keypair.

## Also fixed — `npm run test:all` was red

`packages/cli` still called `pollClaim(claimId)` with one argument after tick 25
made the claim token mandatory, so the workspace `typecheck` (and therefore
`test:all`) had been failing. `claim poll` now takes `--token osc_clm_…` or
`OPENSESAME_CLAIM_TOKEN` and refuses to run without it, matching the API.

## Verification

- `npm run test` -w @opensesame/oauth-provider — 18 tests, incl. new
  canonicalization, allowlist and fail-closed cases.
- `npm run typecheck` -w @opensesame/oauth-provider / `build`.
- `npm run test` -w @opensesame/control-plane — unchanged (dev path).
- `errors.InvalidTarget` confirmed present in the installed `oidc-provider`.

---

## Original report: `2026-08-08-org-client-quotas.md`

# Audit — organization and OAuth client quotas (2026-08-08)

Tick 57. Scope: the newer control-plane routes —
`apps/control-plane/src/routes/oauth-clients.ts`, `organizations.ts`,
`audit.ts` — and the quota path they run through (`state.ts`,
`packages/policy`).

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | Organization and OAuth client creation were gated on assurance alone. Both write into an unbounded in-memory map, so one verified principal could register organizations and clients until the process ran out of room — while every other map in the system (sessions, device codes, frozen intents) has a fence and projects and agents have quotas. The policy module already says out loud that assurance "does not say they may mint resources forever". | `organization.create` and `oauth.client.register` now spend quota slots (`maxOrganizations`, `maxOAuthClients`), counted live from the stores and checked in both create routes. |
| Low | A provisional principal had no organization or client allowance expressed anywhere — the routes refused them, but the policy had nothing to say. | Both provisional limits are explicitly zero, so the PDP answers rather than relying on the route. |

## Not findings

- `GET /v1/audit/events` scopes on the caller's principal id, and both the memory
  and Postgres repositories honour that filter. Event metadata carries actions,
  states and ids — no codes, tokens or digests of them.
- Redirect URIs are already validated against `javascript:`/`data:`/`file:`,
  fragments and embedded credentials, on create *and* patch.
- Client and organization reads are owner-scoped, and unknown versus foreign ids
  answer the same 404.

## Notes

- Counting is live, not cumulative: revoking a client frees its slot, matching how
  projects and agents were fixed in an earlier tick. A cumulative counter would
  make the quota a lifetime cap.
- `POST /:id/rotate` mints a new client record and revokes the old one in the same
  breath, so it does not spend a net slot and is left unfenced by quota.
- Suspended organizations and clients still occupy a slot: a suspension is not a
  way to free capacity while keeping the registration.

## Gates

`npm test`, `npm run typecheck`, `cargo test --workspace`, `cargo clippy
--workspace --all-targets -- -D warnings`, task-security-battle-test, semgrep,
ast-grep, osv-scanner, gitleaks, cve-lite, cargo-audit — all clean.

---

## Original report: `2026-08-08-passkey-counter-device-fence.md`

# Audit tick 37 — passkey signature counter, device approval fence

Scanners (osv-scanner, gitleaks, cargo-deny, clippy, semgrep, cve-lite,
task-security-battle-test) were clean on `main` (9abebc9). Both findings came
from reading the MFA and device-authorization paths.

## 1. Passkey signature counter never advanced (clone detection dead)

`createSimpleWebAuthnVerifyFn` discarded `authenticationInfo.newCounter` and
`createPasskeySeam.verify` only looked at a boolean, so the stored
`credential.counter` stayed at its registration value for the life of the
credential. SimpleWebAuthn's counter check therefore compared every assertion
against a frozen baseline: a cloned authenticator (or one extracted from a
device) could keep asserting indefinitely without the regression ever being
noticed. Challenge single-use already blocked straight replay, but WebAuthn L2
§7.2 step 21 exists precisely to surface cloning, and it was inert.

Fix:

- `PasskeyVerifyFn` may now resolve to `{ ok, newCounter }` (plain `boolean`
  still accepted for dev/test injection).
- `createPasskeySeam.verify` refuses an assertion whose non-zero counter fails
  to exceed the stored value and persists the advanced counter otherwise.
- Authenticators that report `0` (no counter support) keep working.

`packages/auth-upstream/src/__tests__/passkey.test.ts` covers advance, stall,
regression, counter-less authenticators, and the boolean verifier.

## 2. A wrong `user_code` guess cancelled every pending device login

`POST /api/v1/device/approve` counted each miss against **all** live
`DevicePending` entries and pruned any entry at the cap, so five wrong guesses
destroyed every in-flight device authorization on the instance — a trivial
denial of service against device login, available to anyone who can reach the
approve proxy.

A guess cannot be attributed to a specific pending authorization, so the fence
has to be global; it is now a cooldown instead of an invalidation:

- `MAX_APPROVE_FAILURES` (10) failures inside a 60 s sliding window answer
  `429 too_many_attempts` with `retry_after_seconds`.
- Misses cost the guesser budget only; pending authorizations are pruned solely
  by `expires_at`.
- `approve_attempts` was removed from `DevicePending`.

With ~34.6 bits of user-code entropy (8 chars over a 20-symbol alphabet) and
10 guesses/minute, a 15-minute authorization window admits ~150 attempts —
brute force remains infeasible while legitimate approvals survive an attack.

Unit tests in `crates/gateway/src/routes/device.rs` assert that repeated failures
leave the pending set intact and that the failure window prunes and caps.

---

## Original report: `2026-08-08-passkey-user-verification.md`

# Audit tick 59 — passkeys that verify their user

Scanners (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit, cargo-deny, clippy,
task-security-battle-test) were clean. The reading was of the WebAuthn seam in
`packages/auth-upstream`, which the control plane calls the production MFA factor.

## A passkey that never verified its user (fixed)

Both ceremonies were built with user verification optional: the generated options
asked for `userVerification: "preferred"`, and both
`verifyRegistrationAttestation` and `createSimpleWebAuthnVerifyFn` passed
`requireUserVerification: false`.

`preferred` is a request an authenticator may decline. An assertion that declined
it proves the caller holds the authenticator and nothing else — no PIN, no
biometric. `apps/control-plane/src/routes/mfa.ts` turns TOTP away in production and
points callers at `/v1/mfa/passkey/*` as the real factor, so this was one factor
answering for two.

Both ceremonies now demand user verification: `userVerification: "required"` in the
authentication options and in `authenticatorSelection` at registration, and
`requireUserVerification: true` on both verifications. Registration is included on
purpose — enrolling an authenticator that cannot verify its user would mint a
credential that can never satisfy an assertion.

## One principal evicting another's ceremony (fixed)

`createMemoryChallengeStore` caps itself at `MAX_OUTSTANDING_CHALLENGES` and, when
full, dropped whatever was oldest globally. Issuing is one authenticated request,
so a principal asking for challenges in bulk could push every other principal's
outstanding challenge out of the store and fail their logins mid-ceremony.

Eviction now prefers the issuing principal's own oldest challenge, falling back to
the global oldest only when the issuer holds no slot. Flooding still costs the
flooder its own challenges; it no longer costs anyone else theirs.

## Read and left alone

- The signature counter is persisted and non-advancing counters are refused
  (`packages/auth-upstream/src/passkey.ts`) — clone detection is live.
- Challenges are consumed before verification, so a failed ceremony burns its
  challenge rather than leaving it for a retry.
- Authentication challenges are only issued under an authenticated session, and an
  assertion is matched against the challenge's bound principal.

---

## Original report: `2026-08-08-placeholder-substitution.md`

# Audit tick 65 — placeholder substitution is bound to the placeholder that was issued

Scanners clean (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit, cargo-deny). Read
`crates/env-spec`, `crates/domain` placeholder placement, `crates/connector-host`
substitution, `apps/credential-agent`, `apps/callback-edge`.

Placeholder delivery is the mode that lets a legacy SDK hold a fake token while the
host swaps in the real credential at egress. The swap keys off the placeholder's text,
which makes the text itself the authorization: whatever string is named gets a secret
written behind it.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | Every legacy projection shared one placeholder. `resolve_for_delivery` shaped it with the constant suffix `"opensesame0"`, and `shaped_placeholder` returned a wildcard-free pattern verbatim. Two connections with the same pattern were indistinguishable at the swap. | Fresh 128-bit suffix per projection; a wildcard-free pattern also takes the suffix. |
| High | Substitution never checked that the placeholder belonged to the projection. Any caller-named string — a bare `"a"`, or a neighbour's placeholder — was substituted. | `LegacyProjection::accepts_placeholder`, checked first in `substitute_placeholder` (`HostError::PlaceholderMismatch`). Binds to the recorded issued placeholder when known, otherwise to pattern shape with a minimum fill. |
| Medium | `max_occurrences` counted request parts, not appearances. Substitution replaces every occurrence, so one allowed header carrying the placeholder ten times passed a bound of 1 and shipped ten copies of the credential. | Count occurrences. |
| Medium | `allowed_hit` was a single global flag, so an appearance in an allowed site excused an appearance in a denied one. | Every site the placeholder appears at must be allowed; the denied site is named in the error. |
| Medium | A named query location (`Query { name: Some(..) }`) allowed the placeholder anywhere in the query string — the guard read `name.is_none() \|\| q.contains(placeholder)`, whose second arm is always true there. | Count occurrences inside the named parameter's value and require they account for every appearance in the query. |
| Low | An empty placeholder passed every `contains` check, and `replace("", secret)` writes the secret between every character. | Rejected in both `assert_allowed` and `accepts_placeholder`. |

## Tests

- `crates/domain`: pattern acceptance and rejection, exact binding to a recorded
  placeholder, occurrence counting inside one header, a denied second site beside an
  allowed one, named-query scoping, empty placeholder.
- `crates/connector-host`: a foreign placeholder is refused, a repeated one trips the
  bound, and a same-shape neighbour is refused once the issued placeholder is recorded.
- `crates/env-spec`: two resolutions of one schema yield different placeholders, and
  each projection admits only its own.

## Not fixed

- ~~`HostRuntime::invoke_l2_placeholder` still takes `placeholder` and `material` from
  request parameters~~ — closed in `2026-08-08-authority-bounds.md`: the host
  holds a projection and credential per connection reference, refuses a request that
  names `material`, refuses a placeholder other than the issued one, and refuses a
  connection it holds nothing for.

---

## Original report: `2026-08-08-policy-default-allow.md`

# Audit tick 47 — the PEP answered "allow" for everything it had no rule for

Date: 2026-08-08
Scanners: cve-lite, semgrep, clippy, gitleaks, ast-grep, cargo-audit, osv-scanner, cargo-deny, security battle test

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `ProvisionalPolicy.evaluate` — the module documented as "the PEP-facing contract" — returned `allow` for every request from a non-provisional principal, high-risk actions included. Its own `HIGH_RISK_ACTIONS` list (`organization.delete`, `grant.export_raw_credential`, `admin.impersonate`, `claim.force_complete`, …) only applied to provisional callers, and a test asserted the default-allow as intended behaviour. Any route that asked this policy about a dangerous action would have been told yes. | High-risk actions now deny for every subject with `high_risk_requires_explicit_authority`. Nothing in the system grants them today, so the honest answer is no. |
| Medium | Quotas only bound provisional principals, so a verified one could mint temporary projects and ephemeral agents without limit. | Verified principals are held to `DEFAULT_VERIFIED_QUOTA` (50 projects / 500 resources / 25 agents) — a larger allowance, not an absent one. |
| Medium | `evaluateDevicePoll` returned no error for a `consumed` device code, so a token endpoint that reads "no error" as "issue tokens" would mint a second set of tokens from one approval. | A consumed code answers `invalid_grant`; the device code is single use. |

## Notes

- The quota decision was refactored into one `quotaFieldFor` mapping so a new
  quota-bearing action cannot be added to the allowlist while silently skipping its limit.
- Provisional denial reason strings are unchanged (`provisional_quota_projects`), with
  the bare `quota_*` code added alongside, so existing callers keep matching.

## Follow-up

- ~~Usage counters are cumulative and never decremented~~ — closed: `getUsage` counts
  live projects, agents, organizations and OAuth clients from the stores, so an expired
  temporary project releases its slot. Only `temporaryResources` still uses a counter,
  because resources have no store to count from yet.

## Verification

- `npm run test` -w @opensesame/policy — 6 passed (2 new)
- `npm run test` -w @opensesame/device-auth — 5 passed (1 new)
- `npm run typecheck`, `npm test` — clean
- semgrep, gitleaks, cve-lite, ast-grep, clippy, cargo-audit, osv-scanner, cargo-deny — clean

---

## Original report: `2026-08-08-prefix-match-fences.md`

# Audit tick 46 — three fences that compared prefixes instead of parsing

Date: 2026-08-08
Scanners: cargo-audit, osv-scanner, cve-lite, semgrep, security battle test, clippy, gitleaks, cargo-deny, ast-grep

Each of these accepted a value that merely *started with* the trusted string.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `validate_verification_uri_complete` (device flow) accepted any `verification_uri_complete` that began with the issuer origin, so `https://issuer.example.evil.test/device?user_code=…` passed. That URL is opened in the human's browser to approve a device login — a working device-code phish, delivered by the client's own safety check. | Parse both URLs and require scheme, host, and port to match, reject embedded credentials, and confine a path-scoped issuer to its own subtree. |
| Medium | `EgressBinding::allows_url` matched path prefixes with a bare `starts_with`, so a grant attenuated to `/repos/acme` also authorized `/repos/acme-private/secrets`. | Require an exact match or a `/` segment boundary. |
| Medium | `is_blocked_host` (connector host) matched private ranges as strings: `2130706433`, `0x7f000001`, `017700000001`, and `::ffff:127.0.0.1` are all 127.0.0.1 and none started with `127.`, while `172.16/12` was only partially covered by hand-rolled octet parsing. The same code blocked `fcbank.example.com` for starting with `fc`. | Parse the host as an IP — including the integer, hex, octal, and IPv4-mapped spellings resolvers accept — and range-check it; names are left to the egress allowlist. |

## Notes

- The egress allowlist is still the primary destination fence, so the host check is
  defense in depth; that is exactly why it should not have been the one with holes.
- IPv4-mapped and IPv4-compatible IPv6 are judged by their embedded v4 address, matching
  the fix made for the TypeScript metadata fetcher in tick 29. Both now cover
  loopback, private, link-local, CGNAT, benchmarking, documentation, multicast, and
  reserved ranges.

## Verification

- `cargo clippy --workspace --all-targets --all-features` — clean
- `cargo test --workspace` — clean (5 new tests across authn, domain, connector-host)
- semgrep, gitleaks, cargo-audit, osv-scanner, cargo-deny, cve-lite, ast-grep — clean

---

## Original report: `2026-08-08-project-expiry.md`

# Audit tick 53 — temporary projects that never ran out

Date: 2026-08-08
Scanners: cargo-audit, cve-lite, semgrep, ast-grep, osv-scanner, gitleaks, cargo-deny, clippy, security battle test

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | The cleanup worker only expired projects in state `provisional`, so a temporary project that reached `active` — the normal outcome of a completed claim — outlived its own `expiresAt` indefinitely. The TTL a caller was promised was enforced for unclaimed projects and ignored for claimed ones. | Both `provisional` and `active` projects expire once `expiresAt` passes, matching `maybeExpireProvisionalResource` in the domain machine. |
| Medium | Claim completion promoted a project to `active` without checking whether the project had already lapsed, so approval could hand back a project past its TTL that nothing would expire again. | Completion marks a lapsed project `expired` instead of activating it. Reachable only if the claim ever outlives the project — today the claim TTL is derived from it — so this is a guard against the coupling changing, and is tested directly. |
| Low | Expired projects were never removed from the store, so a long-lived process accumulated every temporary project it had ever issued. | Expired and deleted projects are dropped after a one-hour retention window (`reapedProjects` in the tick result). |
| Medium | `sealDevOnly`'s production guard asked `process.env.NODE_ENV === "production"`. A browser bundle has no `process.env`, so the check answered "not production" in exactly the environment it ships to, and the deprecated XOR would have run there. | The question is inverted: the seal refuses unless it can prove it is a dev or test run (`NODE_ENV` of `development`/`test`, or an explicit `__OPENSESAME_ALLOW_DEV_SEAL__` opt-in). An empty key is also refused. |

## Notes

- `sealDevOnly` has no callers today; the fix is to stop the trap being armed for the
  next caller, since the failure mode is silent (XOR "encryption" that looks fine).
- ~~The standalone worker is still constructed with empty session/project maps~~ —
  addressed in `2026-08-08-issuer-persistence-and-worker.md`: those
  dependencies are optional, a tick reports `expiryEnforced`, and the standalone
  entrypoint says it publishes the outbox while expiry runs in-process. Moving
  sessions and projects behind repositories remains the design change.

## Verification

- `npm run test` -w @opensesame/worker — 3 passed (1 new: active project expires,
  then is reaped after the retention window)
- `npm run test` -w @opensesame/control-plane — 31 passed (1 new: lapsed project is
  not activated by approval)
- `npm run test` -w @opensesame/client-core — 4 passed (guard covers the
  no-`NODE_ENV` browser case)
- `npm run typecheck`, `npm test` — clean
- semgrep, gitleaks, cargo-audit, cargo-deny, osv-scanner, cve-lite, ast-grep — clean

---

## Original report: `2026-08-08-proof-key-and-coverage.md`

# Audit — proof keys and signature coverage (2026-08-08)

Tick 58. Scope: `crates/proof` — DPoP proof decoding and validation
(`jwk.rs`, `validator.rs`), the replay cache, key custody, and the RFC 9421 HTTP
message signature validator.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | The RFC 9421 validator accepted whatever component set the signer chose — `parse_signature_input` only required the list to be non-empty. A signature covering `@method` alone verified fine, which leaves the body free to change under the same signature and lets the signature travel to a different endpoint. RFC 9421 leaves the required set to the verifier; this verifier required nothing. | `@method`, `@target-uri` and `content-digest` are now all required before a signature is accepted. |
| Medium | A DPoP proof key was accepted at any strength: a 512-bit RSA modulus, or an exponent of 1, bound a token to a key an observer can recover — after which the token's `cnf` claim confirms them. | `assert_proof_key_strength` runs before signature work: RSA needs a 2048-bit modulus (measured after leading zero padding) and an odd exponent above one; OKP must be Ed25519 with a 32-byte public key. |
| Low | `created` on an HTTP message signature was only checked for age, so a future-dated signature outlived its window. | Rejected beyond 60 seconds of skew, matching the DPoP `iat` check. |
| Low | A JWK claiming `kty: OKP` with curve P-256 got a thumbprint computed for it before anything questioned the combination. | Refused as an unsupported algorithm. |

## Not findings

- The DPoP `ath` comparison is exhaustive and fails closed on every mismatched
  pairing, including a proof that carries `ath` when no access token was presented.
- The replay cache is bounded by TTL and capacity and fails closed at capacity
  rather than evicting, which would reopen the window.
- `htu` comparison normalizes through `url::Url`, so default ports and dot
  segments do not create a mismatch, and query and fragment are excluded per
  RFC 9449.
- Key custody generates its own Ed25519 keys and signs only against a
  pre-authorized binding digest; no externally supplied JWK reaches it.

## Notes

- A weak proof key never let an attacker forge a proof directly — the fence is
  that `jkt` must equal the token's confirmation claim, which is a preimage
  problem. What it allowed was binding a token to a key someone else can derive.
- Strength is checked before `DecodingKey::from_jwk`, so a refusal names the key
  rather than a signature failure further down.

## Gates

`cargo test --workspace` (70 suites), `cargo clippy --workspace --all-targets --
-D warnings`, `npm test`, `npm run typecheck`, task-security-battle-test,
semgrep, ast-grep, osv-scanner, gitleaks, cve-lite — all clean.

---

## Original report: `2026-08-08-receipt-signing-key.md`

# Audit tick 49 — ephemeral receipt signing key

Date: 2026-08-08
Scanners: cargo-audit, cve-lite, semgrep, ast-grep, osv-scanner, gitleaks, cargo-deny, clippy, security battle test

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | The gateway built its `ReceiptSigner` with `ReceiptSigner::generate()` on every boot, while receipts persist in the database. Every receipt written before a restart therefore verified as `valid: false` at `GET /api/v1/receipts/{id}/verify` — so the non-repudiation record could never be checked, and a genuine receipt was indistinguishable from a forged one. | `ReceiptSigner::from_seed` / `from_seed_b64` load a stable key from `OPENSESAME_RECEIPT_SIGNING_KEY` (base64 32-byte ed25519 seed). Production refuses to start without it; dev still generates one and warns. |
| Medium | `verify_receipt` checked the signature against the signer's own key without looking at `authority_key_id`, so a receipt signed by any other key was reported as a bad signature — tamper evidence for what is actually a key-management problem. | Verification now refuses up front when `authority_key_id` does not match the signer, with a message that names the cause. |

## Notes

- `authority_key_id` was already inside the signed digest, so relabelling a receipt
  has always broken its signature. The gap was purely in how the mismatch was
  reported, and in the key never being stable enough for the check to matter.
- Verification still uses a single current key, so a deliberate key rotation would
  strand older receipts. Serving a verifier registry keyed by `authority_key_id`
  (and publishing the public keys) is the next step and is tracked separately.

## Verification

- `cargo test -p opensesame-audit` — 5 passed (2 new: restart survives, seed parsing)
- `cargo test --workspace` — 0 failures
- `cargo clippy --workspace --all-targets -- -D warnings` — clean
- cargo-audit, cargo-deny, osv-scanner, semgrep, gitleaks, cve-lite, ast-grep — clean

---

## Original report: `2026-08-08-receipt-verifier-registry.md`

# Audit tick 50 — receipt verification keyed by authority, and published

Date: 2026-08-08
Scanners: cargo-audit, cve-lite, semgrep, ast-grep, osv-scanner, gitleaks, cargo-deny, clippy, security battle test

Follows tick 49, which made the receipt signing key stable but left verification
trusting exactly one key.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | `GET /api/v1/receipts/{id}/verify` checked every receipt against the single active signing key, so rotating the key stranded every receipt the previous one signed — the only way to keep old receipts verifiable was never to rotate. Worse, keeping them verifiable meant keeping the old *seed*, so rotation could not actually retire secret material. | A `ReceiptVerifier` registry maps `authority_key_id` to a trusted public key. Retired keys are supplied as public halves via `OPENSESAME_RECEIPT_VERIFY_KEYS`, so the old seed can be destroyed while its receipts stay verifiable. |
| Medium | The receipt public keys were never published, so verification existed only as the gateway's own assertion — a receipt could not be checked by the party holding it, which is the point of a signed receipt. | `GET /api/v1/receipts/keys` publishes the accepted key ids with their ed25519 public keys. A holder can rebuild the verifier from that material alone (covered by test). |

## Notes

- `authority_key_id` is derived from the public key (`receipt-key:<hex>`), so a
  receipt cannot name a key other than the one that will check its signature, and
  the registry lookup cannot be steered by the receipt.
- An unknown key is reported as unknown rather than as a bad signature: a rotated
  or ephemeral key is a key-management fact, not tamper evidence. Tampering under a
  trusted key still fails the signature check.
- The keys endpoint is deliberately unauthenticated — it serves public material and
  independent verifiability is the goal.

## Verification

- `cargo test -p opensesame-audit` — 8 passed (3 new: retired key still verifies,
  published keys round-trip, empty verifier trusts nothing)
- `cargo test --workspace` — 0 failures
- `cargo clippy --workspace --all-targets -- -D warnings` — clean
- cargo-audit, cargo-deny, osv-scanner, semgrep, gitleaks, cve-lite, ast-grep — clean

---

## Original report: `2026-08-08-resource-server-sdk.md`

# Audit tick 66 — the resource-server SDK verified less than it looked like it did

Scanners clean (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit, cargo-deny,
osv-scanner). Read `packages/sdk-server` — the verifier and Hono middleware a third
party drops in front of its own API to trust OpenSesame tokens. Whatever this package
fails to check, every integrator fails to check.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | A token with no `exp` verified forever. `jwtVerify` only checks the claims a token happens to carry, and none were required. | `requiredClaims: ["iss","sub","aud","exp"]`. |
| High | No algorithm pin. The verifier accepted whatever algorithm the key it found could carry, leaving the choice to the token rather than the resource server. | `algorithms` pinned to an asymmetric default set, overridable per deployment. |
| High | Issuer and JWKS URI were taken at any scheme. A JWKS fetched over cleartext is one an attacker on the path chooses, and every signature check after that is theatre. | `assertSecureUrl` on both: https, or http on loopback for local development. |
| Medium | The middleware ran `await next()` inside its own `try`. A downstream handler's failure came back as `401 invalid_token` with the handler's error message in `error_description` — an internal error echoed to whoever asked. | `next()` moved outside the catch. |
| Medium | `error_description` returned the verifier's own error text (JWKS fetch failures, claim details) to the caller. | Fixed description; the real error still reaches `onError` and the integrator's logs. |
| Low | 401s carried no `WWW-Authenticate` challenge, which RFC 6750 requires of a bearer-protected resource. | Challenge added to both 401 paths. |

Also added opt-in `requireAccessTokenTypeHeader` for issuers that stamp the RFC 9068
`at+jwt` header, so an integrator can refuse anything that is not an access token
outright rather than relying on the `token_use` claim being present.

## Tests

`packages/sdk-server/src/verifier.test.ts`: a token with no `exp` is refused, an
algorithm outside the accepted set is refused, cleartext issuer and JWKS URIs are
refused while loopback stays usable, the RFC 9068 header is enforced when asked for,
a 401 carries a challenge and no verifier internals, and a handler's own failure is
not reported as an invalid token.

## Not fixed

- ~~The JWKS URI still defaults to `{issuer}/jwks`~~ — closed: the verifier reads the
  issuer's discovery document, believes it only if it names the configured issuer, and
  requires the `jwks_uri` it gives to be https (or loopback). `{issuer}/jwks` is now
  only a last resort for an issuer that publishes no metadata.

---

## Original report: `2026-08-08-sealed-store.md`

# Audit 2026-08-08 — the sealed store's "ciphertext only" guarantee

Tick 73 read `packages/client-core`, the façade the Pages app, the PWA and the
browser extension all use to keep their sync store on disk. Its stated invariant is
that OPFS holds ciphertext only.

## The guard checked for its own test fixture

`persistSealedStore` refused a payload only if the JSON contained the literal
string `plaintext-should` — a string from its own test — or a `"plaintext":` key.
`assertNoPlaintextInSealedJson` looked for `secret-payload` the same way. So the
one thing the invariant was supposed to stop, a real vault document written to
disk, passed: actual credentials contain neither marker. The old unit test even
asserted that `{"blobs":[{"ciphertext":"abc"}]}` — not the store's shape at all —
was acceptable.

Both now validate the document structurally against the shape the store actually
has: a cursor naming a device and an epoch, plus blobs whose payload is base64,
with no other keys anywhere. Unknown keys are exactly where a plaintext document
would hide, so there are none. `parseSealedStore` is exported for callers that
want the parsed value rather than an exception.

## A stored file was adopted as identity without being checked

`loadSealedStore` returned whatever text OPFS held, and the PWA read
`cursor.device_id` out of it and adopted it — then used it as the file name for the
next write. A planted or half-written file therefore chose this client's device
identity, its epoch, and a path fragment. Device and blob ids are now bounded to a
safe character set and length, epochs must be non-negative safe integers, and the
blob list is capped.

A file that does not validate is treated as absent rather than as truth, so a
truncated write is replaced with a fresh envelope instead of shadowing a good copy
forever. The file name is also sanitized on the way out, so a device id can never
address anything but its own file.

## Not fixed here

- The store is still sealed by whatever the caller sealed it with; `sealDevOnly`
  remains an XOR fenced to dev/test, and the real AEAD lives in the Rust
  `client-core` wasm build. This tick checked the container, not the cipher.
- ~~Nothing binds a sealed store to the device that wrote it.~~ — closed: a store's
  cursor must name the device it is stored under, so a well-formed file copied from
  another profile is refused on write and read as absent.

---

## Original report: `2026-08-08-session-digest-agent-ownership.md`

# Audit tick 40 — session bearers at rest, agent claim ownership

Scanners (cargo-audit, ast-grep, osv-scanner, cve-lite) were clean on `main`
(79ff390). Both findings come from reading the Host API session middleware and
the Identity plane agent routes.

## 1. Host API session bearers were stored in cleartext

`opaque-session:<id>` *is* the bearer, and the id was the key of
`AppState.sessions` — with the same cleartext value repeated inside the stored
metadata (`session_id`). Worse, `require_session` handed that cleartext id back
to callers, and `sync.rs` persisted it as the value of `blob_owners`, so a live
credential sat in two maps. Device codes and claim tokens have been digest-only
since ticks 25/27; sessions had been missed.

Fix:

- Sessions are keyed by `hash_secret(session_id)`.
- The stored metadata copy carries the digest in `session_id`; the response to
  the device-token client is unchanged, so `opensesame login` and the CLI's
  `session.json` fallback still work.
- `require_session` returns the digest, which is what sync-blob ownership
  compares — ownership semantics are identical, minus the cleartext.

Regression test `session_bearer_is_never_retained` asserts the bearer is neither
a key nor present in the serialised stored metadata.

## 2. Any principal could start a claim over another principal's agent

`POST /v1/agents/:id/claim` only checked that the agent existed. The claim it
creates carries `targetManifest.ownerPrincipalId = <caller>`, and completing an
agent claim flips the agent to `claimed` — so a foreign caller could run a
takeover ceremony for someone else's agent, and could enumerate agent ids by
status code.

`Agent` now records `ownerPrincipalId` (set at registration), and the claim route
answers 404 for anything the caller does not own. Schema: `agents.owner_principal_id`
with an FK to `principals` and an index (migration `0002_curvy_norman_osborn.sql`).

Test: `fences agent claim ceremonies to the registering principal` — intruder
gets 404, owner gets 201.

---

## Original report: `2026-08-08-ssrf-host-parsing.md`

# Audit — SSRF host parsing (2026-08-08)

Tick 55. Scope: the destination fences — `crates/connector-host`
(`is_blocked_host`, the fence in front of every host-mediated egress),
`packages/oauth-provider/src/metadata/safe-fetcher.ts` (CIMD metadata fetch),
plus the loopback checks in `apps/mcp-host/src/host-api.ts` and
`crates/host-core`.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `is_blocked_host("::1")` returned false. `Ipv6Addr::to_ipv4` reads `::1` as the routable `0.0.0.1`, and the early return on that view shadowed the `is_loopback` check below it, so `https://[::1]/` passed the fence. | The v6 rules are evaluated first; the embedded v4 view is an additional check, not a substitute. |
| High | Short `inet_aton` spellings were not read as addresses: `127.1`, `10.1`, `0177.0.0.1`, `0x7f.1` all resolve to private addresses through `getaddrinfo`, and each fell through to "a name we cannot resolve here". | `parse_inet_aton` accepts one to four parts, each decimal, octal or hex, with the last absorbing the remaining bytes — matching what resolvers accept. Out-of-range parts are refused rather than wrapped. |
| Medium | A zone id defeated parsing: `fe80::1%eth0` was not link-local as far as the fence was concerned. | The zone id is stripped before parsing. |
| Medium | A trailing dot defeated both the name and address checks: `localhost.` and `127.0.0.1.` resolve normally. | The DNS root dot is stripped. |
| Medium | NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) wrap an IPv4 destination the network unwraps; neither fence looked inside. Present in both the Rust fence and the TypeScript metadata fetcher. | `embedded_v4` / `embeddedIpv4` extract the wrapped address and judge it. |

## Not findings

- `apps/mcp-host/src/host-api.ts` and `crates/host-core` check loopback as a
  strict allowlist, so unrecognized spellings fail closed. `127.1` is refused
  there rather than accepted — the safe direction for an allowlist.
- The TypeScript metadata fetcher runs its checks on the WHATWG-canonical host,
  which already folds `127.1` and `2130706433` into dotted quads. Only the
  NAT64/6to4 wrappers were missing.

## Gates

`cargo test --workspace` (70 suites), `cargo clippy --workspace --all-targets --
-D warnings`, `npm test`, `npm run typecheck`, task-security-battle-test,
semgrep, ast-grep, osv-scanner, gitleaks, cve-lite, cargo-audit, cargo-deny —
all clean.

---

## Original report: `2026-08-08-ssrf-ipv6-bypass.md`

# Security audit — metadata SSRF denylist IPv6 bypass — 2026-08-08

Branch: `chore/audit-tick29`

## Scanners

| Check | Result |
|------|--------|
| osv-scanner / cargo-audit / cargo-deny | CLEAN |
| Residual review | `assertSafeMetadataUrl` only recognised the dotted `::ffff:a.b.c.d` spelling |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| High (gated) | WHATWG URL canonicalizes `http://[::ffff:127.0.0.1]` to `::ffff:7f00:1`, and the hex spelling skipped the IPv4 checks — loopback, RFC1918, and `169.254.169.254` were all reachable through IPv4-mapped/IPv4-compatible IPv6 literals | Expand IPv6 to 8 hextets, extract the embedded IPv4 from `::ffff:0:0/96` and `::/96`, and apply the IPv4 rules |
| Medium | IPv6 prefix checks were string-prefix based, so `fc00::/7` / `fe80::/10` edges were partially missed and multicast was allowed | Bitmask checks for `fc00::/7`, `fe80::/10`, `ff00::/8`; unparseable IPv6 now fails closed |
| Low | IPv4 list omitted multicast/reserved, `192.0.0.0/24`, `198.18.0.0/15` | Added; `a >= 224` covers multicast, reserved, and broadcast |

Reachability is limited: the fetcher is off unless `OPENSESAME_CIMD_ENABLED` is set
and redirects are already `redirect: "error"`. Decimal/octal IPv4 (`2130706433`,
`0177.0.0.1`) was already safe via URL canonicalization — now covered by tests.
DNS rebinding remains out of scope for a pre-resolution denylist.

## Gate

```bash
npm run test -w @opensesame/oauth-provider
npm run typecheck -w @opensesame/oauth-provider
npm run test -w @opensesame/control-plane
```

---

## Original report: `2026-08-08-sync-quotas.md`

# Security audit — sync store quotas — 2026-08-08

Branch: `chore/audit-tick28`

## Scanners

| Check | Result |
|------|--------|
| cve-lite / ast-grep / clippy / semgrep | CLEAN |
| gitleaks working tree | CLEAN |
| gitleaks git history | 5 findings, all on unmerged `feat/pages-vault-redesign` (fixture/sample strings and a `PREFS_KEY` storage-key name) — not on `main`; owner branch to rename or allowlist before merge |
| Residual review | E2EE sync store had only a global blob ceiling |

## Findings fixed

| Severity | Finding | Fix |
|----------|---------|-----|
| Medium | One authenticated session could push up to the global 4096-blob ceiling, starving every other tenant, with no per-blob size limit | Per-session ceiling (512) and per-blob ciphertext ceiling (256 KiB); response reports both plus rejection counters |
| Low | `device_cursors` was keyed by unbounded client-supplied `device_id`, so an authenticated session could grow the map without limit | Cap device id length (128) and cursor table size (4096); new devices only tracked while under the ceiling |

Admission logic extracted into a pure `push_outcome` so quota, ownership, and
stale-epoch behavior are unit-tested (foreign owner still cannot overwrite, and
updates to already-owned blobs stay allowed at quota).

## Gate

```bash
cargo +1.88.0 clippy -p opensesame-gateway --all-targets -- -D warnings
cargo +1.88.0 test -p opensesame-gateway --bins
```

---

## Original report: `2026-08-08-task-authority-bounds.md`

# Audit tick 69 — a number from the caller decided how long authority lives

Scanners clean (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit). Read
`apps/mcp-host` (tools, host API fences, task context) and the Host API task routes it
drives in `crates/gateway/src/routes/tasks.rs`.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `start_task` took `ttl_seconds` from the request body and handed it straight to `chrono::Duration::seconds`. Nothing bounded it, so a task's authority could be asked to live for centuries — and at the extremes of `i64`, chrono answers an out-of-range second count by panicking, so the request took the handler down instead of being refused. | `bounded_ttl` refuses anything outside 1..=86400 before a duration is built. A test pins that chrono really does panic on `i64::MAX`, which is why the check comes first. |
| Medium | The capability ceiling was built from an unbounded array. A ceiling is meant to be the short list of what a task needs, and it is digested and carried on every intent it authorizes. | At most 64 capabilities, at least one. |
| Medium | `task_status` fed its response into `updateTaskFromResponse`, which adopted whatever task it described. The tool takes a `task_run_id` from the model, so reading another task made it the active one — a look became a move. | Adoption is now explicit: `task_start` adopts, `task_status` only refreshes the task already active. |
| Low | `operator_invoke_l1` left the spent intent in the task context. The server consumes a digest once, so a second call could only be refused, but the context went on describing authority that no longer existed. | `clearFrozenIntent` after the invoke. |

The MCP tool schema now mirrors the Host API's bounds (≤64 capabilities, ≤86400s), so
a model gets a clear local refusal rather than a 400 from the far end.

## Not fixed

~~`start_task` still takes `organization_id` from the body~~ — closed in
`2026-08-08-authority-bounds.md`: the organization must be one the caller holds
authority in (the bootstrap organization in this deployment), or the call is `403
organization_mismatch`.

Task ceilings are still not bounded against issued grants; that needs a grant issuance
path for ordinary principals.

---

## Original report: `2026-08-08-task-authority-expiry.md`

# Audit tick 39 — task authority expiry, fenced result buffers

Scanners (osv-scanner, gitleaks, cargo-deny, cve-lite, task-security-battle-test)
were clean on `main` (62db7ea). The findings come from reading the Trust Ratchet
engine in `crates/task-access`.

## 1. Task authority never expired

`TaskRun::maximum_expires_at` was only consulted when bounding a credential
renewal window. Nothing compared it against the clock, and `assert_capability` —
the enforcement gate used by `POST /v1/tasks/:id/freeze-intent` and
`Broker::invoke_frozen` — only checked status, state version and ceiling digest.
A run therefore kept authorizing work indefinitely past its deadline, which is
precisely the property ADR 0018 relies on to make task authority safer than a
standing grant.

Fix: `TaskRun::assert_not_expired(now)` (new `DomainError::TaskExpired`), called
from `assert_capability` and `renew_credential`. `assert_capability` now takes
`now`; both call sites pass the same instant they already use for freshness.

## 2. A superseded result buffer was released by a later commit

`ProtectedResultBuffer` is keyed by task run, but `commit_transition` released
whatever buffer it found. A proposal that carried a payload and demanded
mediation acknowledgements could be superseded by a second proposal with no
payload and no required acknowledgements; committing the second one released the
first one's payload, defeating the enforcement fence (ADR 0028). Release is now
bound to the committed transition's id **and** target state version.

## 3. Lost updates on non-CAS writes

`propose_restriction` and `terminate_task` persisted with `save_run`, so a
concurrent commit could be overwritten by a stale in-memory copy — restoring the
wider pre-restriction capability set. Both now use `save_run_cas` against the
version they validated.

Tests: `capability_assertion_expires_with_the_task` and
`superseded_result_buffer_stays_held_after_a_later_commit` in
`crates/task-access/src/tests.rs`. `cargo test --workspace`, clippy,
`cargo fmt --check`, `npm run test:task-access` and semgrep are clean.

---

## Original report: `2026-08-08-task-receipt-ownership.md`

# Audit tick 33 — authenticated ≠ authorized on task and receipt routes

Date: 2026-08-08
Scope: `crates/gateway/src/routes/{tasks,receipts}.rs`, `crates/gateway/src/middleware/auth.rs`

## Scanners

| Check | Result |
|-------|--------|
| gitleaks (working tree) | CLEAN |
| cargo-audit (379 crates) | CLEAN |
| cargo-deny (advisories/bans/licenses/sources) | ok |
| clippy `--workspace --all-targets --all-features` | CLEAN |
| Residual review | task + receipt routes had authentication but no ownership check |

## Findings fixed

### 1. Any session could mint task authority for any principal (high)

`POST /api/v1/tasks` read `principal_id`, `organization_id` and the whole
`capabilities` list from the request body and compiled the immutable ceiling
from them. Tick 23 added `require_session_or_operator`, so the route was
authenticated — but any authenticated session could start a task run *as another
principal* with a self-declared ceiling, which is precisely the authority
laundering ADR 0019 (immutable ceiling) and ADR 0027 (one effective authority)
exist to prevent.

### 2. Task runs were readable, freezable and cancellable across principals (high)

`GET /api/v1/tasks/{id}`, `GET /api/v1/tasks`, `POST /api/v1/tasks/intents` and
`POST /api/v1/tasks/{id}/terminate` looked runs up by id with no ownership
check. Consequences: enumerate every task run and its principal id; freeze an
intent that spends another principal's ceiling and get back an intent digest
bound to them; cancel anyone's task run (denial of service).

### 3. Receipts were readable by id by any session (medium — IDOR)

`GET /api/v1/receipts/{id}` and `POST /api/v1/receipts/{id}/verify` required a
session but not the *right* session. Receipts name the principal, connection,
operation, resource, delegation chain and result summary of an invocation, so
this was cross-principal disclosure of who did what to which resource. Raw
`sqlx` error strings were also returned verbatim on the failure path.

## Fix

Added a shared `Caller` in `middleware/auth.rs` resolved once per request:

- `Operator` — unfenced (the CLI already sends `Bearer operator:…` for all task
  commands, so no caller changes were needed).
- `Principal(id)` — a session, fenced to the principal it was approved as. A dev
  session whose subject is not a principal id resolves to the bootstrap
  principal, which is exactly the principal its invocations are stamped with.
- `Unbound` — authenticated but no resolvable principal; owns nothing.

Then:

- `start_task` rejects a body principal that the caller does not own
  (`403 principal_mismatch`).
- `get_task`, `terminate_task` and `freeze_intent` filter the loaded run through
  `caller.owns(&run.principal_id)` and answer `404` when unowned, so the routes
  are not existence oracles for other principals' runs.
- `list_tasks` returns only the caller's own runs.
- Receipt reads go through one `load_owned` helper (same 404 semantics), and DB
  errors are passed through `opensesame_redaction::redact_text`.

## Known gap (not this tick)

`start_task` still accepts an arbitrary capability list for the caller's *own*
principal — the ceiling is bounded by the caller's identity but not yet by a
stored grant. Bounding compiled ceilings against issued grants needs the grant
store on the task path and is tracked separately.

## Verification

- `cargo clippy --workspace --all-targets --all-features` — clean.
- `cargo test --workspace` — all green, including new `Caller` ownership cases.
- CLI task/intent commands unaffected (operator-token callers).

---

## Original report: `2026-08-08-user-code-digests.md`

# Audit — user code digests (2026-08-08)

Tick 54. Scope: the claim consent path — `packages/claims` (TypeScript engine),
`packages/os-domain/src/crypto/claim-token.ts`, `crates/claims`, and the Host
routes that mint and check user codes.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | Host stored user codes as `sha256(code)` with no key and no salt. A user code is 8 characters from a 20-letter alphabet (~2^35), a space that is exhausted quickly, so the digest was close to the code itself for anyone who read state. | `hash_low_entropy(pepper, context, code)` — HMAC-SHA-256 keyed by `OPENSESAME_CLAIM_PEPPER`, with purpose, context and code length-prefixed. Used for both device-flow and agent-claim user codes. |
| Medium | Every claim's `userCodeDigest` was HMAC'd under the same fixed `"user-code"` label, so one precomputation over the ~40-bit code space covered every claim ever issued. | `digestUserCode`/`verifyUserCode` now take the claim id and bind it into the digest; each claim is its own search. `digestDeviceCode` binds the session id the same way. |
| Medium | Host digests were compared globally, so a user code recovered from one device code or claim was equally good against every other. | Digests are bound to the device-code digest / claim id. Device approve recomputes per candidate entry (bounded at 512 pending). |
| Low | `ClaimEngine.completeClaim` re-entered itself on a lost review CAS with no bound, so concurrent completers could recurse until the stack gave out. | Attempt counter bounded at 8, matching `applyTransition`, then `CONFLICT`. |
| Low | `loadFresh` returned `won ? session : session`. | Collapsed — the store's version is authoritative either way. |

## Notes

- Existing user-code digests do not verify after this change. Claims and device
  codes live 10–15 minutes, so the window is a restart, not a migration.
- `hash_secret` is unchanged and still correct for high-entropy bearers (claim
  tokens, device codes, session ids), where there is no searchable preimage
  space. The doc comment now says so.
- The Host logs an error and continues with an empty pepper when
  `OPENSESAME_CLAIM_PEPPER` is unset in production, matching how the operator
  token behaves rather than refusing to boot.

## Gates

`cargo test --workspace`, `cargo clippy --workspace --all-targets -D warnings`,
`npm test`, `npm run typecheck`, task-security-battle-test, cargo-audit,
cargo-deny, semgrep, ast-grep, osv-scanner, gitleaks, cve-lite — all clean.

---

## Original report: `2026-08-08-vault-kdf-params.md`

# Audit tick 45 — the vault trusted KDF parameters it got back from the server

Date: 2026-08-08
Scanners: cve-lite, semgrep, ast-grep, gitleaks, clippy, cargo-audit, osv-scanner, cargo-deny, security battle test

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `unwrap_vrk_with_password` read `params_m_kib`, `params_t`, and `params_p` straight out of the stored `PasswordWrapper` and handed them to Argon2. The wrapper round-trips through a server the design explicitly does not trust (server-blind E2EE), so those are attacker-chosen: `params_m_kib = 4 * 1024 * 1024` asks the client to allocate 4 GiB to unlock a vault, and a downgrade to `m = 8, t = 1` yields a wrap that an offline guesser can grind cheaply. | `assert_argon_params_accepted` bounds the work band (64 MiB–1 GiB memory, t 3–16, p 1–4) and is checked before any hashing; out-of-band wrappers answer `KdfParamsOutOfRange`. |
| Medium | The unwrap path ended in `out.copy_from_slice(&key)`, which panics whenever the authenticated plaintext is not exactly 32 bytes — a wrapper produced by any other version of this code crashes the client instead of failing. | Length is checked and returns `KeyLength`; the decrypted buffer is zeroized on both paths, as are the Argon2 output and the derived KEK. |
| Medium | `decrypt_item` checked `envelope.version` but ignored `envelope.ad.envelope_version`, so a re-digested envelope could declare a different AD version while the header stayed at 1 and the version gate never fired. | Both must agree, or decryption refuses. |
| Medium | `startCleanupLoop` (worker) had no error boundary: one throwing tick ended the loop, and with it claim, session, and project expiry — credentials would outlive their TTL for as long as the process stayed up, silently. | The tick is wrapped, the failure is logged, and the loop continues on the next interval. Covered by a test that throws on the first tick and asserts the loop keeps going. |

## Notes

- Zeroizing intermediates matters here because `VaultRootKey` is `ZeroizeOnDrop` while
  the material it was derived from was not — the wrapper key lived on in the stack frame.
- No TypeScript mirror of the password wrapper exists yet, so the band only needed
  enforcing once; if `packages/client-crypto` grows one, it must carry the same bounds.

## Verification

- `cargo clippy --workspace --all-targets --all-features` — clean
- `cargo test -p opensesame-human-vault` — 12 passed (3 new)
- `npm run test` -w @opensesame/worker — 2 passed (1 new)
- semgrep, gitleaks, cve-lite, ast-grep, cargo-audit, osv-scanner, cargo-deny — clean

---

## Original report: `2026-08-08-vault-nonce-length.md`

# Audit 2026-08-08 — a stored nonce could panic the vault client

Date: 2026-08-08
Scanners: cve-lite, osv-scanner, cargo-audit, gitleaks, semgrep, ast-grep, clippy,
task-security-battle-test — all clean. This came from reading
`crates/human-vault`.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | `decrypt_item` and `unwrap_vrk_with_password` passed a base64-decoded nonce straight to `XNonce::from_slice`, which panics on any length but 24. Both nonces arrive inside a record this crate explicitly does not trust — the module header says the server stores ciphertext and the KDF band comment says wrapper fields are untrusted input — so a corrupt or hostile envelope crashed the client instead of failing to decrypt. In the wasm build that is a trap that takes the vault session with it. | `decode_nonce` refuses any other length with a new `NonceLength` error. |
| Low | `wrap_vrk_with_password` left both the Argon2 output and the derived KEK in its frame. The unwrap path already zeroized both. | Wrap now zeroizes both, matching unwrap. |

The panic was reproduced before the fix: a five-byte nonce asserted `left: 5, right: 24` inside `GenericArray::from_slice`.

This is the same class the crate had already thought about one line lower —
"authentic but wrong-sized material must be an error, not a panic on
`copy_from_slice`" guards the unwrapped key length. The nonce was the one length
still taken on faith.

## Checked and clean

`crates/client-core` uses `XNonce::from_slice` twice on the same primitive. Its
`open` rejects anything shorter than 24 bytes and then `split_at(24)`, so the slice
handed over is always exactly 24. No change needed.

## Not fixed here

- `kek_from_webauthn_prf` still returns a bare `[u8; 32]`, so the KEK's lifetime is
  the caller's problem. Wrapping it in a zeroizing type is an API change for every
  caller.
- Base64 that does not decode and base64 that decodes to the wrong length are now
  distinguishable to a caller (`Aead` versus `NonceLength`). Both mean the record is
  unusable, and neither says anything about the key.

## Verification

- `cargo test -p opensesame-human-vault` — 14 passed (2 new: envelope nonce and
  wrapper nonce, each across 0/5/12/23/25/64 bytes plus non-base64 and the good case)
- `cargo clippy -p opensesame-human-vault --all-targets -- -D warnings` — clean
- `cargo test --workspace --lib` — green
- cve-lite, osv-scanner, cargo-audit, gitleaks, semgrep, ast-grep, clippy,
  task-security-battle-test — clean

---

## Original report: `2026-08-08-vault-unlock.md`

# Audit 2026-08-08 — the vault unlock, and one definition of loopback

Tick 72 read `apps/pages/src/lib/lock.ts`, the PIN gate in front of the Pages
vault. The gate is honest about what it is — the app says the PIN never decrypts
anything, and the catalog behind it is metadata only — so what is at stake here is
the lockout and the cost of guessing, not confidentiality of secrets.

## A new PIN stood in for knowing the old one

`setUnlockPin` wrote a fresh record, cleared the attempt counter, and set the
session unlocked, without asking for anything. Only the UI decided when to offer
it (`firstRun = !hasUnlockPin()` at mount). So the progressive lockout — the whole
point of the attempt counter — was escaped by choosing a new PIN instead of
guessing the old one.

`setUnlockPin` now refuses to replace an existing PIN unless the session is already
unlocked, and `changeUnlockPin(current, next)` proves the current PIN first. The
internal writer both paths share is what the legacy and weak-parameter upgrades
call, so those still work without a hole in the guard.

## A stored record chose its own KDF cost

`unlock` derived with `stored.iterations` verbatim. Storage is not a place that
earns trust: a record naming `iterations: 1` is cheap to guess against offline,
and one naming `1e12` hangs the tab — a lockout by another name. A zero-length or
malformed salt was accepted too, and bad base64 escaped as a raw `atob` exception.

Records are now bounded on the way in: an integer count within a sane ceiling, a
salt of at least 16 bytes, and base64 that decodes. A record below today's floor
is accepted once — so nobody is shut out of their own vault — and then rewritten
at current cost, the same upgrade the unsalted-SHA-256 path already had.

## A planted deadline locked the vault forever

`readAttempts` returned whatever `lockedUntil` it found. A value a year out — from
a rewritten record or a skewed clock — meant the vault stayed shut for a year. The
deadline read back is now clamped to the policy maximum of fifteen minutes.

## One fence, not three copies

Tick 71 hand-rolled loopback and base-URL checks in `apps/pages` and
`apps/console`, while `@opensesame/api-client` already exported
`normalizeLoopbackBaseUrl` and `normalizeHttpBaseUrl` — the fence the extension
uses, with tests for credential smuggling and lookalike hosts. Both surfaces now
delegate to those, which also fixed a real gap in the copy: a base carrying a
query or fragment was accepted and would have swallowed every path joined to it.

## Not fixed here

- Client-side lockout state is advisory; anything that can write our storage can
  reset the counter, and nothing in a browser can prevent that. It costs an
  attacker the derivation work, which is why the iteration floor matters.
- ~~The legacy unsalted SHA-256 record is still accepted (and upgraded) forever.~~
  — closed: `LEGACY_PIN_RETIRED_AFTER_MS` (2027-01-01) refuses the record past that
  date instead of upgrading it again.

---

## Original report: `2026-08-08-worker-does-real-work.md`

# Audit 2026-08-08 — the cleanup worker did nothing, quietly

Date: 2026-08-08
Scanners: cve-lite, osv-scanner, gitleaks, semgrep, ast-grep, clippy, cargo-deny —
all clean. This came from following up an open item in
`2026-08-08-issuer-persistence-and-worker.md` and reading
`apps/worker/src/main.ts` again.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | The standalone worker called `createRepositories()` with no arguments. That falls back to `DATABASE_URL`, and when it is unset returns **in-memory** repositories. For the control plane that is a usable dev mode, because the process writing the outbox is the one reading it. A separate worker process reading its own empty map does nothing at all, forever, while logging healthy ticks. | The worker requires `DATABASE_URL` and exits rather than impersonating a working one. |
| Medium | `oidc_payloads` rows past their TTL were refused on read but only removed by `pruneExpired`, which nothing called. Sessions, authorization codes, refresh tokens, device flows and grants accumulated with no bound — a table that only grows, holding authorization state long after it stopped meaning anything. | The cleanup tick prunes them every interval; the worker constructs the store to do it. |

The first one is the same shape as the finding the previous tick fixed. That tick
stopped the worker from *claiming* expiry it could not perform; it left the worker
still unable to perform the one job it did claim.

## How pruning is wired

`CleanupDeps.oidcStore` takes just `Pick<OidcStore, "pruneExpired">`, so a tick
needs nothing else from the store and tests can pass a two-line stub. The prune is
best-effort and wrapped: a store that throws logs and the tick continues to publish
the outbox, because reads already refuse an expired row. A failed prune is a table
that stays large, not a token honoured late. `prunedOidcRows` is absent rather than
zero when there is no store, so "nothing to prune" and "no store to prune from" do
not read the same in the logs.

The prune uses the tick's clock, not wall time, which the test asserts — a fake
clock that does not reach the store would be testing a different TTL.

## Not fixed here

- Rows the provider stores with no TTL are its long-lived models and are left alone.
  Nothing yet reaps a grant that was never revoked and never expires.
- The control plane does not run this loop; claims expire lazily on read there.
  A deployment that runs no worker still never prunes.
- Provisional sessions and temporary projects still have no repository, so their
  expiry remains confined to the process holding the maps.

## Verification

- `apps/worker` — 5 passed (1 new, covering the pruned count, the tick's clock
  reaching the store, a throwing store not costing the outbox, and an absent store
  differing from an empty prune)
- Confirmed by running it: with `DATABASE_URL` unset the worker logs the reason and
  exits instead of looping
- `npm run -r typecheck`, `packages/database` tests, biome — green
- cve-lite, osv-scanner, gitleaks, semgrep, ast-grep, clippy, cargo-deny — clean
