# Formal authentication and authorization verification

This register connects security requirements to their implementation, formal
model, and checks. The present Lean coverage consists of bounded slices of the Identity API and Host. It is not a
proof of OpenSesame's complete authentication or authorization system. Update this register whenever the covered behavior changes or a new
formal property is introduced.

This workflow draws on Lauren Tan's Pstack
[create](https://github.com/cursor/plugins/blob/main/pstack/skills/create-formal-verification-skill/SKILL.md)
and [maintain](https://github.com/cursor/plugins/blob/main/pstack/skills/maintain-formal-verification-skill/SKILL.md)
formal verification skills: map source behavior to the model, exercise negative
controls, and state the bounds of each claim as the implementation evolves.

## Checked properties

The reviewed source revision is recorded in
[`coverage.json`](../../spec/formal/auth/coverage.json), together with hashes of
the source files actually reviewed. Principal and project proof design is in
[ADR 0178](../adr/0178-authorization-checks-are-proofs-the-compiler-can-see.md).
The provisional token-prefix requirement is recorded in the
[session ID audit](audits/2026-08-07-provisional-session-id.md). The model and
theorem names below are in
[`AuthPolicy.lean`](../../spec/formal/auth/AuthPolicy.lean),
[`AuthTransport.lean`](../../spec/formal/auth/AuthTransport.lean) and
[`AuthSession.lean`](../../spec/formal/auth/AuthSession.lean), which
`check-axioms.sh` checks as one model. The admission model represents a lookup
result and a role result as already obtained; the storage it reads is modelled
separately below.

| ID | Requirement and implementation | Lean property | Executable correspondence |
|---|---|---|---|
| AUTH-S1 | A provisional session authenticates only for a `pst_` token mapped to a present, unexpired, unrevoked session (the mapping is the live provisional-token row stored at the token's keyed id, `HMAC-SHA-256(K_lookup, token)`; no other stored id is consulted) and a present principal that is neither suspended nor closed. [`resolveProvisionalSession`](../../packages/control-plane/src/middleware/auth.ts) performs those checks. | `bad_session_prefix_denied`, `unmapped_session_denied`, `missing_session_denied`, `revoked_session_denied`, `expired_session_denied`, `missing_principal_session_denied`, `suspended_principal_session_denied`, `closed_principal_session_denied` | The actual resolver is compared with 960 Lean-generated combinations of the abstract guards, expiry boundary, principal state and the two AUTH-S2 resolver guards. |
| AUTH-S2 | A session that AUTH-S1 admits is still refused while its revocation cleanup is pending (`revocationCleanupPending`) or while its principal has a pending organization withdrawal (`hasPendingWithdrawalForPrincipal`). The `prn_` principal bearer (only with `allowPrincipalBearer`) uses the same principal check. A bound-cookie request (`X-OpenSesame-Session-Id`, `-Session-Proof`, `-Principal-Id`) authenticates only when the named cookie resolves through AUTH-S1 and these guards, to that session and principal, with a matching proof hash and an allowed origin, and it never falls back to another credential. A client that sends `X-OpenSesame-Require-Bearer: 1` with an `Authorization: Bearer` that does not authenticate gets 401, never the ambient cookie; the header has no effect on a request without a bearer. [`resolveProvisionalSession` and `authMiddleware`](../../packages/control-plane/src/middleware/auth.ts), [`boundCookieMatches`](../../packages/control-plane/src/middleware/bound-cookie.ts). | `Session` in `AuthSession.lean`: `resolves_requires_session_admitted`, `cleanup_pending_session_denied`, `pending_withdrawal_session_denied`, `bound_never_falls_back`, `bound_admission_requires`, `required_bearer_never_uses_cookie`, `bearer_requires_resolution`, `principal_bearer_requires`, `cookie_requires`, `admitted_session_satisfies_auth_s1` (every session the middleware admits passed the AUTH-S1 checks and both guards). | The resolver vectors include both guards (960 cases above). The real `authMiddleware`, mounted in Hono with stores answering each token, is compared with 512 Lean-generated bound-request cases (nine facts, with a valid bait bearer and ambient cookie on every request) and 112 credential cases (seven bearer kinds, `allowPrincipalBearer`, require-bearer, four cookie states). Negative controls: `session-cleanup-pending`, `session-pending-withdrawal`, `bound-fallback`, `bound-proof`, `bound-principal`, `require-bearer`, `principal-bearer`, `cookie-origin`. Status: **proved for the model, with exhaustive correspondence over the abstract domain**; sources mapped in the `auth` registry suite. Outside: Hono header and cookie parsing, the `boundCookieMatches` SHA-256 and `timingSafeEqual` comparison (abstracted to one fact), store and repository implementations, the separate session reads by the resolver and `boundCookieMatches` (no concurrency or interleaving is modelled), and what `boundCookieProxy` does after admission. |
| AUTH-C1 | A fresh guest must require sign-out when an existing Identity or federation session is detected, and must not reuse, replace, or act under a session installed concurrently. [`connectFreshProvisional`](../../packages/app-core/src/lib/identity.ts) checks the remote cookie before and after minting. The guarded [`POST /v1/principals/provisional`](../../packages/control-plane/src/routes/principals.ts) rejects presented credentials and returns a bearer without setting a cookie. Guest requests and bearer cleanup omit ambient cookies; a tab-persistent isolation marker prevents cookie adoption after expiry or reload. A member cookie arriving after the last check can coexist with the guest, but cannot replace or authenticate that guest. [`continueAsGuest`](../../packages/app-core/src/lib/guest-auth.ts), claim guest continuation, and the Identity ceremony use this admission path. Assumptions: configured remote deployments share the authoritative cookie plane; device-native Identity has no cookie plane; browser session storage and the at-rest key are available for remote guest admission. | Browser decision logic **proved for the model, with exhaustive Lean-generated correspondence; implementation mapped** ([`spec/formal/guest`](../../spec/formal/guest/README.md), registry suite `guest`): admission `admitted_only_if_every_check_clear`, `session_seen_anywhere_refuses`; fresh mint `fresh_adopts_only_clear`, `minted_unadopted_is_revoked`, `unknown_status_refuses`; local-only guest `local_only_guest_never_sends_grant`, `send_requires_last_boundary_clear`, `no_grant_reported_to_local_only_guest`; sign-out epoch `commit_requires_same_generation`, `signout_during_operation_refuses`, `unreadable_generation_refuses`. **Unproved**: the Identity route and its transaction boundary, cookie delivery, the isolation marker, UI state, and real browser concurrency (Web Locks, cross-tab timing). | Client regressions cover present, absent, unknown, held cross-tab responses, cookie-free requests, revocation retry, storage failure, bearer loss, established-guest resume, claim, device roads, and held federation responses after a settings change or sign-out. Control-plane tests cover credential rejection and a bearer-only response; FrontDoor and locked-vault tests cover sign-out and retry. The non-mechanized AUTH-C1 review snapshot records the exact implementation blobs below. Lean-generated correspondence (`npm run verify:guest-formal`) drives the real `continueAsGuest` (82,944 cases: three checks × 24 observations each, local or remote Identity, every mint outcome; the in-lock check runs inside the real `mintGuestSessionPersonLocked`), `connectFreshProvisional` over stubbed HTTP (18 cases, including another tab's sign-out during the mint), `pairedHostFetch`/`currentBrowserGrant` (40 boundary traces) and `captureSignOutEpoch`/`assertSignOutEpoch` (12 store cases); eleven negative controls are each detected. Status: modelled browser logic **proved for the model and checked on every model case**; AUTH-C1 as a whole **unproved**. |
| AUTH-P1 | An absent principal is refused and a principal with `provisional` assurance is refused. [`verifiedPrincipal`](../../packages/control-plane/src/proofs/verified-principal.ts) makes both checks. | `missing_principal_denied`, `provisional_principal_denied`, `admitted_principal_not_provisional` | The actual function is compared with all eight abstract lookup/assurance cases. |
| AUTH-Z1 | A missing project, an invisible project, or a caller without a resolved role gets no project proof. [`projectAccess`](../../packages/control-plane/src/proofs/project-role.ts) calls [`isVisible` and `roleFor`](../../packages/control-plane/src/services/project-access.ts). | `absent_project_denied`, `hidden_project_denied`, `no_role_denied` | The actual functions are compared with the model across project presence, every declared state, four expiry classes, and four role results. |
| AUTH-Z2 | A member gets no admin proof; only a resolved owner can receive an owner proof. `projectAccess` creates the role-specific proof values. | `member_never_receives_admin`, `nonowner_never_receives_owner` | The same matrix checks the role and the actual proof fields and kinds. |
| AUTH-Z3 | A project at or after its expiration instant is invisible; a deleted project is invisible. `isVisible` uses an inclusive expiry check. | `not_visible_at_expiry`, `not_visible_after_expiry`, `deleted_project_not_visible` | The matrix includes times before, exactly at, and after expiry for every project state and role. |

The AUTH-S1 token-to-session lookup, the principal session epoch fence and the
revocation audits read durable secret-keyed maps
([`durable-map.ts`](../../packages/control-plane/src/repos/durable-map.ts)).
Storage contract since 2026-11-24, stated so it can be modelled:

- **Keyed lookup only.** Every key-addressed read, write, claim, take and
  delete addresses exactly one stored id, `HMAC-SHA-256(K_lookup, key)`. No
  request path computes an unkeyed digest of a key, and no request reads a row
  stored under any other id.
- **No-expiry records are migrated before serving.** Rows written before
  2026-11-23 were stored under `HMAC(K_lookup, SHA-256(key))`. At startup,
  before the listener opens and before any request passes the readiness gate
  in `app.ts`, every such row in the four no-expiry stores (upstream logout
  operations, organization revocation and withdrawal audits, principal session
  epochs) is moved to its keyed id in one locked transaction that writes the
  successor with the same expiry before deleting the legacy row; a key's
  existing current row is kept. If any no-expiry legacy row remains, startup
  fails closed and every request but the liveness probe gets 503
  ([`security-map-rekey.ts`](../../packages/control-plane/src/repos/security-map-rekey.ts),
  [`durable-map-legacy.ts`](../../packages/control-plane/src/repos/durable-map-legacy.ts)).
- **Pre-upgrade bearers are refused.** Bearer-keyed rows the server cannot
  re-key, because it never stored the bearer (provisional tokens and proofs,
  magic-link exchanges, enrollment tickets, passkey challenges, OpenID4VCI
  codes, nonces and access tokens), are not migrated. Each is TTL-bounded. A
  bearer issued before the upgrade resolves to nothing, exactly like an unknown
  bearer, so AUTH-S1 refuses it; its row expires with its TTL, and revocation
  by session still deletes it through the stored entry.

The session-admission model takes the lookup result as given. A separate
storage model (`OpenSesame.AuthPolicy.Storage` in `AuthPolicy.lean`) states
this contract for one `DurableMap` and Lean 4.24.0 checks it with the auth
suite's axiom audit. A row id is only a keyed lookup of the key or of its
legacy digest (`RowId`); `liveAt` is the `live()` filter and, as a store, the
purge of expired rows. Keyed lookup only: with the legacy fallback removed
every address is the keyed id (`legacy_free_addresses_keyed_only`), a read
depends only on that address (`lookup_reads_only_addresses`), `set` purges
expired rows and stores only at the keyed id, leaving a legacy row in place
(`write_stores_only_keyed`, `write_then_lookup`), and changes no other key's
read (`write_other_keys`); `claim` never replaces a live row
(`claim_never_replaces_live`), `delete` leaves nothing to read
(`delete_then_lookup`) and `take` is single-use (`take_single_use`).
Migration before serving: `rekey` models `adoptLegacyRow` (the successor is
written unless the keyed id holds a row live at the migration instant, then the
legacy row is deleted); it touches no other key (`rekey_other_ids`) and never
changes what the key reads at that instant (`rekey_preserves_lookup`);
`migrate` adopts only the rows `legacyRows()` lists (live ones, as `rekeyKeys`
and `rekeyRecoverable` do), and migrating the recovered keys leaves every
no-expiry legacy row findable by the keyed id alone at every later time, unless
a live keyed row with an expiry already held the key
(`migration_keeps_no_expiry_rows`); once no live legacy row remains, which is
startup's condition for serving, dropping the fallback changes no read
(`served_store_needs_no_fallback`). Pre-upgrade bearers: a key held only under
its legacy id is refused (`legacy_only_row_refused`).

Fixed gap (2026-11-24): `adoptLegacyRow` used to keep a key's existing keyed
row without checking that it was live, so an expired keyed row beside a live
no-expiry legacy row lost the legacy value (a session-epoch fence read back as
`undefined`). It now selects the current row with `live()` and upserts the
successor over an expired one; regression `adopts a live legacy fence over an
expired current row instead of dropping it` in `durable-map-migration.test.ts`
fails before the fix and passes after, and the model's `rekey` follows the
fixed rule, so `rekey_preserves_lookup` no longer needs a liveness hypothesis.

Implementation refinement (2026-11-24). Writing the refinement showed that the
previous model's `write` deleted the key's legacy row, as the pre-#2927 map
did; the current `set` leaves it and only purges expired rows, and the model
now says so. `durable-map.ts`, `durable-map-legacy.ts`, `durable-record.ts` and
`security-map-rekey.ts` are mapped in the `auth` registry suite and its
`coverage.json`, so a change to them requires `npm run verify:auth-formal`.
The correspondence (`session-conformance.test.ts`) runs the real `DurableMap`
(secret keys, no TTL) on a PGlite database migrated with the repository's
migrations: for each of 112 Lean-generated cases, sixteen states of the key's
keyed and legacy rows (absent, expired, live with an expiry, no expiry) times
`get`, `set`, `claim`, `delete`, `take`, `adoptLegacyRow` and `rekeyKeys`, it
seeds sealed rows exactly as the current and pre-2026-11-23 maps wrote them,
and compares the result, both stored rows (value and expiry class), the
following read, the `legacyRows()` count and another key's untouched rows with
the model. Negative controls `storage-live-read`, `storage-take-live`,
`storage-legacy-live`, `storage-adopt-live`, `storage-adopt-expiry`,
`storage-claim` and `storage-purge` are each detected. Status: **proved for the
model, with exhaustive correspondence over one key's sixteen row states and
seven operations**. Outside, and unproved: concurrency, transactions and the
advisory lock, crash durability, capacity, sealing and HMAC (the disjointness
of keyed and legacy ids is an assumption), interactions among more than two
keys, Postgres beyond PGlite, the operation clock (`new Date()` per statement),
`rekeyRecoverable`'s ownership check and the startup orchestration in
`security-map-rekey.ts` (mapped and covered by `durable-map-migration.test.ts`,
not by the correspondence).

Guest bearer revocations that fail are retained in memory and retried before
another guest mint against the same Identity API in that tab. Cleanup and
session work are bound to the original full API base, so a changed service
does not receive that bearer. If the original service is not selected again,
its inaccessible lease expires at the configured TTL. A reload deliberately
loses the bearer, which is never persisted; its authority lease then expires at
the configured TTL. The isolation marker survives the reload so a member
cookie cannot silently replace the guest. A successful sign-out or deliberate member
adoption ends that isolation.

The revoke endpoint invalidates the presented sessions on the authority. It
does not send a cookie deletion: a delayed name-only deletion could erase a
newer sign-in cookie. The invalid old cookie cannot authenticate and expires
or is replaced by the next sign-in.

Sign-out on the client ([`signOut`](../../packages/app-core/src/lib/session-exit.ts))
runs each local clearing step independently, so blocked browser storage cannot
stop the Identity session being ended or the vault being locked; a failed step
leaves a transient "Sign-out incomplete" notice with a retry. This is outside
AUTH-C1's reviewed sources. Model (`OpenSesame.AuthPolicy.SignOut` in
`AuthSession.lean`, 2026-11-24): every step runs inside a runner that turns a
throw into "incomplete", so for any set of failing steps every step is
attempted (`exit_attempts_every_step`), the Identity session is ended
(`exit_ends_session`), an open vault or one awaiting a second step is locked
(`exit_locks_open_vault`), the exit is incomplete exactly when some attempted
step threw (`exit_incomplete_iff_failure`), and `settleSignOut` runs only for a
complete exit (`exit_settles_only_when_complete`). Correspondence is
source-structural: `auth-conformance.test.ts` parses the real
`session-exit.ts` with the `verify:auth-source` helpers and requires the exact
runner (`try { run(); } catch { incomplete = true; }`), the lock guard, the
incomplete branch and, at each of the eleven Lean-generated positions, a step
wrapped in the runner calling the step the model names. `session-exit.ts` is
mapped in the `auth` registry suite. Negative controls `signout-catch`,
`signout-end-session`, `signout-unwrapped` and `signout-lock-guard` are
detected. Status: **proved for the model, with source-structure
correspondence**. Unproved: that JavaScript `try`/`catch` and the browser
behave as assumed (the property is executed only by `session-exit.test.ts`'s
blocked-storage case), what each step clears, the notice UI, a throw from
`reportIncomplete` or `dismissNotice` themselves, and `settleSignOut`'s network
outcome.

AUTH-C1 was independently reviewed against these exact Git blobs. A squash
commit that contains the reviewed implementation retains these content-addressed
objects, so the evidence does not depend on an intermediate commit remaining in
history. The auth-formal drift gate checks current bytes against these recorded
Git blob IDs, but that consistency check does not establish that an independent
review occurred or that AUTH-C1 is correct; future changes require a new
independent review and snapshot update:

- `packages/app-core/src/lib/identity.ts`: `e0485ac9d329655c7d21a69cdd0118e0a0e8c97c`
- `packages/app-core/src/lib/identity-probe.ts`: `eeff84e7fc64eccc07426cd49cf04aca60a76364`
- `packages/app-core/src/lib/identity-token-proof.ts`: `47c7a46311b3a9e68a819ccbcf608d96f148fb76`
- `packages/app-core/src/lib/identity-session-types.ts`: `264a48c5fd9b232fcaa5abaca6dcdc9f9418077b`
- `packages/app-core/src/lib/identity-cookie-inspection.ts`: `ea77513a3432f17079e3a950a0b0272bffb86a14`
- `packages/app-core/src/lib/identity-signout.ts`: `00a851d87df7f4388cd613f6a03ddbdf9960b591`
- `packages/app-core/src/lib/identity-revocation-journal.ts`: `d5f6fbcb3e73b5ec2166b53cc8a630cb2ff699d0`
- `packages/app-core/src/lib/identity-shared-signout.ts`: `43520769f31ebcdfb74da915bf83827947994081`
- `packages/app-core/src/lib/auth-generation.ts`: `aedd30d13cc09db3ce2118e3b03b92623851bebc`
- `packages/app-core/src/lib/device-identity.ts`: `b0ceab8071f03a140a355b4918f876918edd11fa`
- `packages/app-core/src/lib/browser-pairing.ts`: `9c72b60517687770f83d778a568063d5f9b83642`
- `packages/app-core/src/lib/guest-auth.ts`: `dfbcca45eb1dc2c9b4684bbd067a8278289b8abe`
- `packages/app-core/src/lib/federation.ts`: `03292f8f7a79698cd6ea6b3ca55b035108e36e46`
- `packages/app-core/src/lib/federation-publication.ts`: `a3a0f9f86aafb2d3c83a49a9ad2c47f4099a6ed0`
- `packages/app-core/src/lib/settings.ts`: `b5a08a31403ab5d9bf7f82ee0b8961e4079e9694`
- `packages/app-core/src/lib/claims/transport.ts`: `994e9de1fe080cf0c81e62c62cc4f93dd75b600f`
- `packages/app-core/src/lib/claims/ceremony.ts`: `4a2206a3ddb5dbc33b12d80cbff87ba6c2b6b24a`
- `packages/control-plane/src/app.ts`: `a4859026ec0afbd01eb6768f30be15297579e85a`
- `packages/control-plane/src/routes/principals.ts`: `9c8365b05f92fcb81c041fe1206a9b862d4cb1d9`
- `apps/pages/src/components/IdentityCeremony.tsx`: `a26e68d32330338317ff679cd35a86f6f6b889f7`
- `apps/pages/src/components/ConnectionCeremony.tsx`: `89fc81187818e662b78915b066ae5fd51ebd3e5f`
- `apps/pages/src/components/status-mark.css`: `ae855527fd73a13db16e382e5dd04a6249933ad7`
- `apps/pages/src/screens/FrontDoor.tsx`: `f115adb482976ad92ef252cd4fb2613145d9bc2e`
- `apps/pages/src/screens/door.css`: `d6ba80f79e8ee3a4dbd485e17c9d1b40c99f3c7e`
- `apps/pages/src/screens/unlock/GuestRoad.tsx`: `cea5725e83f995950ccb2e95482455b66a5d110b`

2026-11-22 re-review of `IdentityCeremony.tsx`: the session-refresh control is no longer drawn for a bearer-only (fresh-guest) session. Refreshing cleared the guest's only bearer, and with guest isolation active the reconnect minted a different provisional principal, stranding the guest's data. The change removes a path; it adds no credential handling or request, and every AUTH-C1 guard is unchanged. Regression: `IdentityCeremony.test.tsx` (`offers no refresh to a bearer-only guest…`), 12/12.

2026-11-22 re-review of `identity.ts` and `IdentityCeremony.tsx`: a fresh guest that links into an existing account (`standOnRebound`) now keeps `bearerOnly`, since the link request withheld cookies and the rebound bearer remains its only credential; the refresh control is also withheld for adopted (pasted) sessions, which have no cookie to renew from. Both changes keep a cookie-less session from being cleared and replaced by a newly minted principal; no request, credential or guard is added or relaxed. Regressions: `identity-rebind.test.ts` (`keeps a fresh guest's rebound session bearer-only`) and `IdentityCeremony.test.tsx` (`offers no refresh to an adopted (pasted) token…`).

2026-11-22 re-review of the AUTH-S1 sources and AUTH-C1 snapshot (session-revocation lineage merged onto main). `middleware/auth.ts` adds only refusals and narrower paths, recorded as AUTH-S2. `os-domain/src/types.ts` re-exports `ProvisionalSession` from `provisional-session.ts`. The fields AUTH-S1 reads keep their meaning, and the added fields are optional. `coverage.json` now names the reviewed revision `8f269718b1db89bd1abc7cc4d4e6218bfddff6b3`. AUTH-C1: `principals.ts` keeps the fresh-guest guard ahead of idempotency, and the bearer-only mint now also skips this lineage's bound restore cookie. The revoke route no longer deletes a cookie by name. `app.ts` only allows both branches' CORS request headers and exposes `X-OpenSesame-Cookie-Bound`. `federation.ts` keeps main's settings-epoch fence and runs magic-link completion before ambient or OIDC handling. That completion adopts the session through `restoreSession`, fenced to the session epoch and to the Identity API base the link was requested from. As a deliberate member sign-in, it ends guest isolation. No credential is reused or replaced under a fresh guest. Regressions: app-core identity*, guest*, device-identity, federation*, claims, settings, browser-pairing and magic-link* (867 tests in 70 files); Pages IdentityCeremony, ConnectionCeremony, FrontDoor and unlock (289 tests in 36 files); control-plane auth-session-interleaving (including the new `sets no bound cookie for a fresh guest that also sends a restore proof`), auth-admission, bound-cookie* and principals* (43 tests in 6 files). Lean was not available in this environment, so `npm run verify:auth-formal` and the Lean theorem check were not re-run. The correspondence suite (409 tests) and all twelve negative controls passed against session, principal and project vectors generated from the same model definitions.

2026-11-23 re-review of `federation.ts` and `app.ts` (Codex P2 findings). `federation.ts`: `completeReturn` now reports a finished email-link sign-in as a distinguishable outcome instead of `null`, and the return screen opens the vault or records an `authenticated` banner for it; `completeSignIn` still returns `null` for that case. The magic-link completion order, its session-epoch and Identity-base fences, and the ambient and OIDC paths are unchanged, and no credential is reused or replaced under a fresh guest. `app.ts`: the bound-cookie mint and proxy dispatch the rewritten internal request with the original Node bindings (`c.env`), so the routed handler sees the real socket peer for its mint fingerprint and budget instead of the User-Agent fallback. The rewritten request, its stripped cookies and its bearer-only marker are unchanged. Regressions: app-core federation*, magic-link* (including the new `magic-link-client-reload.test.ts`), identity*, guest*, device-identity, claims, settings, browser-pairing, providers, drop-present, `screens/federation-return-model.test.ts` (new) and screens/unlock (913 tests in 76 files); Pages FederationReturn, IdentityCeremony, ConnectionCeremony, FrontDoor and unlock (309 tests in 37 files); control-plane bound-cookie* (including the new `bound-cookie-peer.test.ts`), magic-link*, auth-upstream, auth-session-interleaving, auth-admission, principals* and api (120 tests in 11 files). Lean was not available in this environment, so `npm run verify:auth-formal` and the Lean theorem check were not re-run.

2026-11-23 re-review of the AUTH-C1 snapshot for the durable revocation journal and cross-tab sign-out fences (the identity slice of #2586, checkpoints 9–10, ported onto main's session design). Requirement affected: AUTH-C1 (sign-out, session adoption and fresh-guest admission); AUTH-S1/S2 and the Lean models are untouched. Implementation: `endSession` now records each owed cookie revoke in [`identity-revocation-journal.ts`](../../packages/app-core/src/lib/identity-revocation-journal.ts) before forgetting the session (a sealed local-store entry naming only the Identity API base; no bearer, cookie value or principal is written, so a reload still loses the bearer) and forgets it only after Identity confirms the revoke. [`identity-signout.ts`](../../packages/app-core/src/lib/identity-signout.ts) holds the queued revoke moved out of `identity.ts` unchanged in its requests, plus `requireNoOwedRevocation`, which retries an owed revoke under the `opensesame:identity-revocation` Web Lock and refuses provisional connection and cookie resume while one stays owed; a fresh guest is told to sign out first, a cookie-only restore is refused, cookie inspection reports unknown, and no cookie-bearing Identity request is sent. [`identity-shared-signout.ts`](../../packages/app-core/src/lib/identity-shared-signout.ts) treats a move of the sealed, origin-wide principal generation ([`auth-generation.ts`](../../packages/app-core/src/lib/auth-generation.ts), whose new `readAuthGeneration` reports an unreadable store as unknown) as another tab's sign-out: `identity.ts` then retires its session, queues a cookie-free revoke of its own bearer and bumps the session epoch, so a mint, rebind, pasted-token adoption or OIDC/federation `restoreSession` already in flight is refused and its credential revoked; a content-free broadcast only wakes a quiet tab. `captureSignOutEpoch` and `assertSignOutEpoch` expose the same epoch to code outside `identity.ts`; an unreadable store counts as a sign-out. `endSession` advances that generation when it ends a session or a sign-out. Cookie inspection moved unchanged to [`identity-cookie-inspection.ts`](../../packages/app-core/src/lib/identity-cookie-inspection.ts), the duplicated fresh-guest refusal in `identity.ts` became one helper with the same outcomes, and the guest-isolation test and request-credential choice moved into helpers with identical conditions. [`device-identity.ts`](../../packages/app-core/src/lib/device-identity.ts) sends every remote Identity request with `redirect: "error"`, so a revoke or bearer is never forwarded to another origin. No guard is removed or relaxed: every new check only refuses, defers or revokes. Outside the snapshot, `session-exit.ts` reports "Sign-out incomplete" until the revoke is confirmed and `magic-link-client.ts` fences a link return to the generation it was requested under (exposure matrix `magic-link-return`). Evidence, each new regression confirmed failing against main's sources and passing here: `identity-revocation-journal.test.ts` (sealed entry with no base or bearer in the clear; no cookie resume after a reload while the revoke is refused, then completion; one revoke when two documents recover together; session-only mode keeps the tab fenced and writes nothing; a redirected revoke reaches no other origin and stays owed; no cookie request while owed), `identity-shared-signout.test.ts` (retirement and bearer revoke, broadcast wake-up, refused late restore, rebind, mint and magic-link return) and `session-exit-revoke.test.ts`. Executed: app-core identity*, session*, magic-link*, guest*, federation*, device-identity, browser-reset, claims, ambient-auth, providers, kv and at-rest (100 files, 1060 tests; after the final edits 92 files, 987 tests, adding connectivity-monitor); Pages FederationReturn, IdentityCeremony, ConnectionCeremony, FrontDoor, unlock and vault hooks (42 files, 340 tests); control-plane magic-link-exchange, magic-link-first-party and auth-upstream (30 tests). Explicitly unproved: in session-only mode, or with no Web Storage, the journal and generation live in one document, so a reload or another tab is not fenced; an evicted or reset local store loses owed revokes; the cross-tab fence assumes the shared origin store and Web Locks behave as specified; a cookie whose revoke stays owed is still live on the server until Identity is reachable; and #2586's bound-cookie proofs and isolated `guest_<uuid>` returns are not part of this change. Status: **unproved**.

2026-11-23 re-review of `guest-auth.ts` for the remaining fresh-guest admission cases of #2586. Requirement affected: AUTH-C1 (a fresh guest must not act under an existing session); AUTH-S1/S2 and the Lean models are untouched. Implementation: `assertNoKnownRemoteSession`, the one admission check a fresh guest passes before minting its provisional identity, again after it, and inside the guest-person mint lock, now also refuses when this device holds an approved Host grant (`hostLocalSessionEligible`, the same predicate the Host session path uses) or when a previous tab's Identity cookie still authenticates with no bearer here (`orphanSessionActive`). Both are read through `guestAuthDependencies` and only add refusals with the existing sign-out-first message; the resume path for an existing guest person, the provisional mint, rebind and link paths are unchanged, and nothing is reused, replaced or published by the new checks. Evidence: new [`guest-auth.admission.test.ts`](../../packages/app-core/src/lib/guest-auth.admission.test.ts) (three cases fail on main and pass with the change; the fourth guards against over-refusal); app-core guest-auth*, identity*, session-exit and federation* suites (571 tests) pass. Formal status: unproved; no Lean model covers the Host grant or the cookie inspection. The snapshot row for `guest-auth.ts` is updated to the reviewed blob; no other AUTH-C1 source changed.

2026-11-23 re-review of `browser-pairing.ts` for the local-only guest. Requirement affected: AUTH-C1 (a guest must not act under another account's authority). A guest whose sign-out epoch cannot be relied on across tabs (no durable at-rest key) or that was opened local only is a local-only guest ([`guest-session-context.ts`](../../packages/app-core/src/lib/guest-session-context.ts)). Browser pairing now refuses for such a guest at every await boundary (before and after key creation, after the pairing response, after a poll, after the DPoP proof and after each Host response, whose body is cancelled), and `currentBrowserGrant` reports no grant while one is open, so a Host grant obtained by an earlier session is never sent on its behalf. The change only adds refusals; pairing for every other session is unchanged. Evidence: [`browser-pairing.test.ts`](../../packages/app-core/src/lib/browser-pairing.test.ts) case "does not send a Host grant when a local-only guest opens during proof creation" (fails on main, passes with the change). Formal status: unproved. The snapshot row for `browser-pairing.ts` is updated to the reviewed blob.

2026-11-23 re-review of `federated-pending.ts` (unauthenticated CPU and memory denial of service). Requirement affected: FED-I4, with FED-I1 and FED-I2 re-mapped; AUTH-S1/S2, AUTH-C1 and the other Lean models are untouched. Defect: since #2823, the `/interaction/:uid/federated/callback` decoder ran a blocking `scryptSync` (N=32768, r=8, about 32 MiB) twice per request before checking the cookie MAC, and plaintext-verifier cookies were still accepted. Any caller who started an interaction could block the Identity API event loop with forged cookies (about 146 ms per forged decode, measured locally, against 0.12 ms now). Implementation: the cookie is now v4. It carries an HMAC-SHA-256 over the exact base64url payload under a v4-only key derived from the pepper. That tag is compared, after a 4096-byte length cap, before the payload is parsed, the AES-GCM-sealed verifier is unsealed or any key is derived. scrypt is removed from the codec. The signed wire schema requires `verifierEnc` and is strict, so a plaintext or mixed verifier is refused even under a valid tag. v3 and pre-v3 legacy cookies are no longer verified, since each would need scrypt before authentication. Sign-ins holding one restart; the cookie max-age is ten minutes. The `OPENSESAME_FEDERATED_PENDING_SEAL_VERIFIER` rollout flag existed only for v3 mixed-version rollouts and is removed. Evidence: `federated-pending.security.test.ts`, `federated-pending-integrity.test.ts`, `federated-pending.fuzz.test.ts` and `federated-pending.production.test.ts`. Nine new or changed cases fail against main's sources and pass here, including a key-derivation counter on the `PendingCookieKeys` seam: forged, oversize, wrong-pepper, v3 and plaintext cookies cause no derivation, and a valid one causes exactly one. The control-plane federated, BYO, interaction and config suites pass (33 files, 364 tests). The oauth correspondence suite and its report check pass against vectors from a Python mirror of `PendingIntegrity.lean`, and four new pending-cookie negative controls plus the organization control were each detected in a local simulation of `negative-controls.py`. `check-drift.mjs` and coverage hashes were refreshed. `formal-vitest-report.mjs`, whose oauth test inventory had not matched main's security test since #2823, now lists the v4 tests. The `verify:auth-source` federation snapshot, stale since #2823, is re-reviewed against the v4 source. That gate still fails earlier, on the unrelated `principalStillAuthenticates` extraction, a pre-existing failure outside this change. Lean was not available, so `npm run verify:oauth-formal`, `negative-controls.py` and the theorem check were not re-run. Explicitly unproved: FED-I4 ordering and the absence of slow hashing (tests and source snapshot only), HMAC and AES-GCM security, and refinement of the v4 codec for all inputs. Status: **unproved**.

2026-11-24 Lean re-run and completion of the proofs recorded above as not re-run. Lean 4.24.0 was installed through elan (no Mathlib or Lake packages are used). Requirements affected: FED-I1, FED-I2, FED-I4 (oauth suite), the AUTH-S1 storage contract (auth suite), and the `verify:auth-source` principal check. No implementation file changed. FED-I1: the model's `SealedPayload` now has exactly the fields of the strict v4 `sealedWireSchema`, including `verifierEnc`, and `currentMessage` is `MAC_DOMAIN ‖ payload` (`pendingMac`); **proved**. FED-I2: `acceptsLegacy` is the v4 decoder applied to a plaintext-verifier payload, so the model now refuses every legacy cookie like the implementation (`legacy_never_accepted`, `legacy_static_signed_provider_refused` replaces the retired acceptance theorem), and the 32 legacy cases require exact agreement; **proved**. FED-I4: `decodeTrace` models `decodeSigned` (federated-pending.ts lines 234–260) step by step; `mac_first`, `invalid_tag_no_work`, `accepted_requires_valid_tag`, `accepted_requires_sealed_only`, `accepted_derives_once`, `derivations_at_most_one` and `no_slow_hash`; 160 Lean-generated `v4` cases build real cookies and compare acceptance with real keys and derivation counts through a counting `PendingCookieKeys` seam; **proved for the model**; that the TypeScript performs exactly these steps rests on review and the finite cases, and `no_slow_hash` holds of the model by construction (the code evidence is the codec scan test). Results: `npm run verify:oauth-formal` passed (22 obligations, axioms audited; 297 correspondence and security tests; both hosted-flow tests; source hashes match); `negative-controls.py` detected all five mutants and the gate refused a mutant override; `hosted-flow-negative-controls.py` detected all five controls (it needs `MISE_TRUSTED_CONFIG_PATHS` for its scratch checkout in this sandbox); `npm run verify:auth-formal` passed (29 obligations, 409 correspondence tests, AUTH-C1 snapshot, drift tests, after repairing the drift fixture's pre-#2915 AUTH-C1 inventory); `check-axioms.test.mjs` 14/14. `verify:auth-source` failed on main because #2899 added an awaited `hasPendingWithdrawalForPrincipal` operand; the translator now accepts exactly that call on `principalId`, the policy requires no pending withdrawal, and Lean checks 54 source-derived theorems (25/25 tests, including a new control that drops the operand). AUTH-C1 and GUEST-V1 remain **unproved** and conformance-only: no registry suite maps any `app-core` or Pages source, and their properties concern browser concurrency, cookie delivery, Web Locks, origin storage, OPFS and transaction boundaries that none of the Lean models represent; modelling them would need a new suite with its own implementation mapping and correspondence harness.

2026-11-24 implementation refinement for AUTH-S1 storage, AUTH-S2, IDENTITY-TLS1 and sign-out. Requirements affected: AUTH-S1 (storage), AUTH-S2, IDENTITY-TLS1 and the client sign-out property; no implementation file changed. The auth suite's model now spans `AuthPolicy.lean`, `AuthTransport.lean` and `AuthSession.lean` (`check-axioms.sh` concatenates them; 53 required theorems, axioms audited). The storage model's `write` was corrected to the current `set` (it leaves the legacy row and purges expired rows), `migrate` adopts only live legacy rows like `rekeyKeys`, and `served_store_needs_no_fallback` now assumes only what startup checks (no live legacy row). New correspondence groups in `session-conformance.test.ts` (1,039 Lean-generated cases: 112 storage, 512 bound, 112 credential, 288 evidence, 15 listener) and in `auth-conformance.test.ts` (the 960 resolver cases now include both AUTH-S2 guards; 11 sign-out positions plus the runner shape) run against the real `DurableMap` on migrated PGlite, the real `authMiddleware` in Hono, the real `recordRequestEvidence`/`bindingPeerOf` with `openssl`-issued certificates, a real `createTransportListener`, and the parsed `session-exit.ts`. The `auth` registry suite, its requirements, pins and `coverage.json` map `bound-cookie.ts`, `bound-cookie-name.ts`, `durable-map.ts`, `durable-map-legacy.ts`, `durable-record.ts`, `security-map-rekey.ts`, `listener.ts`, `request-evidence.ts`, `service-admission.ts` and app-core `session-exit.ts`; `auth-formal-drift.mjs` now reads the covered list from the pinned registry mapping. Results: `npm run verify:auth-formal` passed (2,180 correspondence tests, report check, drift and its fixture test); `negative-controls.py` detected all 35 mutants. Status: AUTH-S2, IDENTITY-TLS1 and the sign-out property are **proved for the model, with exhaustive (or, for sign-out, source-structure) correspondence**, and the AUTH-S1 storage refinement likewise; the residual limits are listed with each requirement above. A proof of a model and finite conformance do not prove the whole implementation.

2026-11-24 abstract contract models for AUTH-C1 and GUEST-V1 ([`spec/formal/guest`](../../spec/formal/guest/README.md), `npm run verify:guest-contract-formal`, 16 obligations, axioms audited; Lean 4.24.0). Status for each: **contract proved (abstract model), implementation unmapped**. No source is mapped to the model and no executable correspondence checks it, so it proves nothing about the TypeScript; AUTH-C1 and GUEST-V1 implementation evidence remains the Vitest regressions recorded above. AUTH-C1 admission (`assertNoKnownRemoteSession`, guest-auth.ts): `admitted_only_if_every_check_clear`, `session_seen_anywhere_refuses`, `unknown_status_refuses`. AUTH-C1 local-only guest (browser-pairing.ts): `local_only_guest_never_sends_grant`, `send_requires_last_boundary_clear`, `no_grant_reported_to_local_only_guest`. AUTH-C1 sign-out epoch (auth-generation.ts, identity-shared-signout.ts): `commit_requires_same_generation`, `signout_during_operation_refuses`, `unreadable_generation_refuses`. GUEST-V1: `fresh_guest_never_wipes_another`, `scratch_never_gets_header`, `promotion_header_last`, `interrupted_promotion_has_no_header`, `deletion_journals_before_unlink`, `frozen_guest_only_recovers`, `actor_requires_own_open_tomb`. Not modelled: browser and storage concurrency, Web Locks, cookie delivery, OPFS, per-step crash atomicity, and whether every caller uses these paths.

2026-11-24 implementation models and correspondence for AUTH-C1, GUEST-V1, CONN-S1, LOCAL-D1 and EXT-O1 ([`spec/formal/guest`](../../spec/formal/guest/README.md), `npm run verify:guest-formal`, registry suite `guest`). The abstract contract models above are replaced by models of the code's decision logic, with every await boundary the code re-checks as an explicit input or step; `GuestContract.lean` continues in `CustodyContract.lean` and `check-axioms.sh` checks the two as one model (27 obligations, only `propext` and `Quot.sound`). `main` prints 87,807 vectors and two Vitest files replay every one against the real functions through their existing seams (no module is mocked): `continueAsGuest` (82,944), `connectFreshProvisional` (18), `pairedHostFetch` (40), the sign-out epoch (12), the transient guest store (2,197), `prepareGuestOpen` (10), `publishOriginalHeader` (10), `promoteGuestVault` (13), `deleteGuestFileInTurn` (5), the connector directory (1,155) and Vercel Connect (1,349) staging traces, `readLocalDirectory` (6) and the eight runner page functions (48). `verify.sh` also requires all 13 tests to run and pass and compares the 18 mapped sources with their reviewed blobs in the suite README; `verify.sh --negative-controls` applies 26 single guard mutations in memory and each fails a correspondence assertion. The model changed two earlier abstract statements to match the code: promotion releases its registry reservation (best effort) after the header, so the header is the last vault write rather than the last write; and a sign-out whose generation write is refused is not seen by other tabs (`lost_signout_write_is_unseen`). `actor_requires_own_open_tomb` is dropped: the tab actor is not modelled or mapped. Bug found and fixed in a separate commit: `pfLayout` skipped its origin check for a document with no window and read its layout; it now refuses (regression in `page-fns.test.ts`, failing before and passing after). Status: the modelled logic of each requirement is **proved for the model and checked on every model case, implementation mapped**; a proof of a model and finite correspondence do not prove the whole implementation. Still **unproved**: real browser concurrency between the modelled boundaries, Web Locks and cross-tab exclusivity, cookie delivery and the Identity route, OPFS and file-store semantics, crash durability, cryptography, UI state, traces beyond the executed bounds (CONN-S1 has the invariant proof for all traces), and whether every caller uses these paths.

2026-11-24 models and correspondence for INV-O1, INV-O2, INV-D1 and INV-D2 (registry suite `invocation`, `npm run verify:invocation-formal`; Lean 4.24.0). `Invocation.lean` (INV-I1) continues in `InvocationEffects.lean`, which `check-axioms.sh` appends as the suite's one part (15 obligations, only `propext` and `Quot.sound`). Each family transcribes named Rust guards; `main` prints 156 tagged vectors after the 36 INV-I1 vectors, and four ignored harnesses replay them against the real code: the broker's adversarial `outcome_indeterminate` tests (69: receipts from `invoke` and the independent executor, signing and opening through the real `ReceiptSigner`), its frozen outcome tests (3), the connector host's binding tests (50) and the connection broker's `owner_egress_vectors` (34). `verify.sh` requires each harness to run exactly one passing test, and `verify.sh --negative-controls` builds 34 single-guard mutants in a detached worktree (seven INV-I1, seven INV-O1, three INV-O2, six INV-D1 and eleven INV-D2); every one failed a `vector:` assertion. The suite now maps sixteen sources across broker, domain, audit, connector-host and connection-broker, so it carries an `opensesame-gateway` lock and manifest projection (gateway is the root that composes all five) and maps `crates/gateway/Cargo.toml`. Status, worded in each row above: the modelled logic of INV-O1, INV-O2, INV-D1 and INV-D2 is **proved for the model, with Lean-generated correspondence; implementation mapped**; the gateway parts (`tasks_opening.rs` recovery scoping, `ensure_effect_allowed`, the Wasm registration capture) are not modelled and stay finite conformance, and a proof of a model with finite correspondence does not prove the whole implementation. INV-I1's note that `opensesame-audit` is outside a single-package mapping no longer holds for `crates/audit/src/lib.rs`, which is now mapped; storage stays outside. Bug found and fixed in a separate commit (the Identity API's in-memory store, `packages/database`): the in-memory `executionReservations.acquire` kept a held, never-committed reservation after its transaction rolled back, while Postgres discards it; memory transactions now run rollback undos, with a contract regression that failed before and passes after on both stores.

The Lean theorems quantify over their declared model inputs. Time in the model
is an arbitrary integer. The correspondence test exercises 8 principal cases,
240 session cases, and 160 project cases at representative millisecond values,
with test stores that return the specified rows and memberships. It checks the
real TypeScript functions, but finite testing does not mathematically prove
that TypeScript refines the Lean model for all inputs. Review that mapping
whenever a covered source changes.

`verifiedPrincipal` means **non-provisional assurance** here. It admits
`self_asserted`, and this function does not check the principal's lifecycle
state. The Lean property must not be described as proving a successful login,
a particular authentication factor, or a non-suspended account.

## Reproduce and maintain

Install Lean 4.24.0 using the pinned
[`lean-toolchain`](../../spec/formal/auth/lean-toolchain) and install the
repository's Node dependencies. Then run:

```sh
npm run verify:auth-formal
```

An existing Lean executable can be selected with
`OPENSESAME_LEAN_BIN=/absolute/path/to/lean`. The command rejects another Lean
version and treats Lean warnings, including a `sorry`, as errors. Lean checks
theorems and emits the cases; Vitest compares those cases to the real functions;
finally the source-hash check fails on an unreviewed change to any covered file.
It also compares those hashes to the declared reviewed commit; the commit and
its source blobs must be present locally. Fetch the reviewed history if they
are missing. The hashes detect drift. They do not prove the review or the model
is correct.
The pre-push hook selects registered suites when their mapped implementation
files occur in the commits being pushed, including changes later reverted. The
filter uses file paths: a test-only edit inside a mapped implementation file
can still select its suite, while a separate proof-only or test-only file does
not. For a suite with a registered Cargo.lock projection, it also selects changes to the
reviewed dependency graph; lockfile-only graph selection conservatively includes
inactive optional, development, and target-specific packages. It
also selects authority for changes to its inherited Cargo workspace inputs and
relevant package overrides; its bounded projection and exclusions are described
in the [authority model](../../spec/formal/authority/README.md). The proof
harness uses a separate lockfile and does not claim complete graph equality with
the production workspace. The gate
reads historical policy as data and checks each registry or requirements change
against the requirements in that commit. Earlier registry history from before
the requirements file existed is included in selection. If a changed path had
an incoming mapping, the target must retain it and its proof files and command
from the incoming history and the relevant destination and parent snapshots.
Change a suite's proof-file mappings or command in a separate, metadata-only
push before changing an implementation mapped to it. A changed target policy must include the requirements file; unrelated
and proof-only changes do not run suites. Release qualification runs every
registered suite and checks the same policy. When adding or expanding coverage,
update [`proof-registry.json`](../../spec/formal/proof-registry.json),
[`proof-requirements.json`](../../spec/formal/proof-requirements.json), and the
independent trusted minimum in [`formal-proof-pinned-suites.mjs`](../../scripts/security/formal-proof-pinned-suites.mjs),
together with the tests and this register. The registry and requirements must
match each other and the trusted minimum on suite IDs, implementation paths,
proof files, and commands. All three require review; their agreement alone does
not establish that a proof covers an implementation. Pushes also compare changed
paths with the advertised remote main policy so stale branches cannot silently
omit its mappings. The remote must be reachable for this comparison.
If main moves while its missing history is fetched, the gate rejects the push
and asks for a retry. A local hook cannot make its last remote read atomic with
the server's eventual ref update; server-side policy remains necessary.
Selected suites require a clean worktree with no `assume-unchanged` or
`skip-worktree` index flags, so Git cannot hide proof-input changes.

For a selected suite, the hook compares its npm verification script and npm
pre/post hooks, its listed runner files, and the shared runner files with the
destination and each relevant incoming history snapshot. This detects changes
that are later reverted, including changes through a merge. New refs use the
maximal advertised ancestor tips; if there are multiple incomparable tips,
all must agree. Missing, malformed, or non-regular runner files fail closed.
The protected inputs include each suite's `required-theorems.lean` signatures;
change these separately from a mapped implementation.
The protected inventory is in
[`formal-proof-runner-pins.json`](../../scripts/security/formal-proof-runner-pins.json).
For a selected suite it is parsed as data from the committed Git blob after its
checked-out bytes are verified. An inventory-only update is parsed from the
pushed commit without selecting a proof. The checker independently includes it
in each selected history comparison, so an inventory edit cannot remove its
own protection. The hook, controller, loader, and other executable modules
imported before the check remain trusted inputs, including their import-time
effects.
Each suite row lists its npm script, required runner paths, Cargo configuration
directories, and optional execution-input paths. The array-only format rejects
duplicate suites, duplicate paths within a row, malformed rows, and unsafe paths.
The controller independently requires each pinned suite's theorem-signature
file, essential runner inputs, and applicable Cargo metadata in every incoming
inventory-changing commit and at the target. It rejects malformed or weakened
intermediate versions even when a later commit restores them. Add a new suite
and its complete inventory together in the metadata-only update.
Change a runner or this inventory in a separate metadata-only push before
changing an implementation that selects the affected suite. This also applies
when adding a suite or a new runner file; an advertised predecessor branch can
serve as the baseline for a stacked branch.

For Cargo-based suites, the comparison includes both Cargo configuration
filenames at every repository directory searched from the verifier's working
directory, including files absent from the baseline. Before a changed lockfile
or workspace manifest can be classified as unrelated, the hook checks the
relevant projection helpers and selector against their historical baseline and
their checked-out copies. Update these helpers in a separate
metadata-only push before changing an input governed by a projection.
When a suite runs, the same execution inputs must match the committed worktree,
including absent paths that Git would otherwise ignore. An unrelated push does
not run this check. Cargo configuration outside the repository remains part of
the local environment's trust boundary.

This local comparison is an incremental safeguard, not a trusted verifier or
proof that the baseline was reviewed: an earlier metadata-only push may change
the runner, and a local hook or environment can be bypassed or modified. Model
definitions, correspondence tests, and coverage manifests remain editable
alongside code and could also be weakened. Review and
server-enforced checks, with independently trusted verifier and coverage
baselines, are needed for a stronger guarantee. The runner inventory does not
pin every transitive dependency, executable, or environment input. It does not
establish that a change was reviewed, identify every Rust file that a build
can compile, or prove that the mapped source graph is complete. Review new
modules, build inputs, and conditional compilation against the stated coverage.
A suite covering a local Cargo dependency graph can register a multi-package
workspace projection. Its reviewed manifest paths, each sibling `build.rs`,
and every intermediate `Cargo.toml` path must be mapped implementation
inputs, and its lock projection must cover the entire root closure. The suite's
runner must pin reviewed build-script contents or absence and reject unreviewed
or nonregular scripts before invoking Cargo. The projector accepts only an
absent `package.build`, `false`, or the canonical `"build.rs"` path; custom
build paths fail closed. For each relevant commit and merge parent,
the gate reads regular manifest blobs from that revision, resolves local path
dependencies and aliases, and checks them against the lockfile's local closure.
The workspace projection includes inherited package fields, dependencies and
lints used by that closure, along with relevant patches and profile overrides.
An approved manifest may be absent only while it is outside the closure;
unmapped or ambiguous packages, alternate workspace roots, nested manifests,
unsupported paths and malformed dependency tables fail closed. Both current
and legacy Cargo build/dev dependency table spellings are included.

The lock graph conservatively includes optional, development and target-specific
dependencies but does not encode active features or target choice. These
projections do not establish feature unification from packages outside the
registered closure, toolchain or Cargo configuration integrity, or the behavior
of dependencies and build scripts. Each suite must document and review those
limits separately; the projection is a drift selector, not a Lean refinement
proof.

The Rust suites also independently list the Cargo library, binary, and named
integration-test targets they actually exercise. Before Cargo runs, the drift
check requires each selected name and source path to match that inventory and
its covered hash, rejects unsupported target attributes, and refuses local
build scripts or custom build paths for those packages. Unrelated inactive
targets are outside this inventory. The current push selector maps reviewed
crate manifests as whole files, however, so even an unrelated edit to one of
those manifests can select the suite. Changes to an unrelated inactive target
source are not selected merely because that target exists.

These target checks do not independently discover Rust modules, `include!`
inputs, or macro expansion. Reviewing a covered source change must also review
its wiring and update the implementation mappings for any newly relevant
source; a matching target path and source hash alone do not establish that the
transitive source inventory is complete.

The authority, SPIFFE, source-lifetime, source-trust-selection and peer-domain
Rust runners guard against Cargo reusing artifacts built from another worktree.
They assign a reviewed workspace wrapper to the canonical checkout path, clear
`RUSTC_WRAPPER` for proof subprocesses, and check the pinned inputs before and
after execution. A freshness preflight touches the declared local target roots,
including path dependencies outside the Cargo workspace, and requires active
local artifacts to be freshly compiled in the current proof session before the
test or program runs. It checks the resulting artifacts and runs the input
check again after nonzero exits and caught interruptions; a hard kill cannot
run that final check. The authority harness has its own Cargo workspace and
uses a private temporary target directory.

A workspace path patch that a selected local package names must be declared
with `--reviewed-patch NAME=PATH` on the freshness `init`; an undeclared,
mismatched or unused declaration is refused, and a declared patch is tracked
as a local artifact that must be rebuilt in the proof. Authority hashes the
vendored `sqlx-sqlite` sources directly. Since the 2026-11-23 review, the
SPIFFE, peer-domain, source-trust-selection (both runs) and source-trust-history
runners declare `sqlx-sqlite` (reached through `opensesame-time`'s default
`sqlx` feature), and source-trust-history also declares `keepass` (reached by
the CLI through `kdbx-bridge`). Those crates are not part of these suites'
properties. Each suite instead covers the reviewed vendored-crate verifier
(`scripts/security/verify-vendored-sqlx.py`, `verify-vendored-keepass.py`) and
its drift check executes the verified bytes on every input check: the
published archive must match its crates.io digest, the vendored tree must
equal it file for file apart from the reviewed patch, and both workspaces must
bind the patch only to that directory. Before this review those four runners
refused at `init` from #2652 onward (narrowed by #2626), because the patches
added in #2768 were never declared for them. Since 2026-11-24 the
source-lifetime runner also builds through the freshness session (it had used
plain `cargo`), declares `sqlx-sqlite`, and covers and executes the same
vendored-SQLx verifier; the full suite passed that way (40 tests in 14 runs).
Since a later 2026-11-24 review the scratch negative-control runners build
the patched workspace too. `checked_cargo` in `formal-cargo-isolation.py`
takes the runner's `reviewed_patches` and passes each as `--reviewed-patch`
(an undeclared patch is still refused), and `mutated_coverage` records the
mutant's git blob for checkers that read `reviewed_blob`. The scratch trees
are full `git archive` trees and do contain `patches/vendor`; the refusals came
from the missing declaration, then from these runner defects, each fixed and
re-reviewed: source-lifetime exported no `OPENSESAME_FORMAL_GIT_ROOT`; SPIFFE
kept `reviewed-sources.json` unequal to a mutated manifest, searched for a
refusal reason #2612 renamed, expected an outdated diagnostic, and had two
witnesses that cannot observe their mutant (one replaced by a held-write test,
one dropped beside the Lean vector witness that does catch it); and
source-trust-history mutated a stream loop #2612 had moved into
`source_loop.rs`, which the suite now maps. Every moved pin was re-reviewed
with an appended note. Results: source-lifetime (6 mutants, 7 malformed
matrices), SPIFFE (10), authority (24), spiffe-peer-domain (10, empty vectors,
zero tests), source-trust-selection (4, empty vectors, zero tests), its NATS
run (57 and fixture controls) and source-trust-history (11, plus its drift controls) all
reject every mutant.

Mutation controls use a stable private scratch checkout for each live checkout
and hold its exclusive lock through the compiler and descendants. Cleanup only
removes the registered directory while holding that lock; if an interrupted
child still holds it, a later run waits and can retire the checkout. Explicit
cleanup uses `python3 -I scripts/security/formal-cargo-isolation.py --clean-scratch <checkout>`.
A permanently surviving descendant can therefore block later controls
indefinitely. A hard kill immediately before a staging
directory is registered can leave an empty private directory; interruption
during registration or wrapper creation can also leave small private temporary
files. Repeated hard kills can accumulate these remnants, which contain no
checked-out source or compiled artifacts. A hard
kill of an authority run can leave its private temporary target until removed.

These checks assume a trusted Cargo and Rust toolchain, reviewed runner and
Cargo configuration, and no concurrent uncooperative changes to the source or
target cache during a proof. The scratch lock requires supported POSIX locking
and no-replace rename behavior; unsupported systems fail closed. The lock and
artifact checks provide runtime evidence about the selected builds; they do not
prove that Rust refines the Lean model. Runner and Cargo configuration changes
are execution metadata, and must be protected separately rather than selecting
these implementation-filtered proofs by themselves.

The Rust drift checks load their Cargo projection helpers only after checking
the helper bytes against the suite's coverage record. The authority check also
isolates the workspace helper's nested lock-projection import. This detects
helper drift when that record is trusted; changing both requires review of the
runner metadata and is not ruled out by a hash alone.

The shared Lean checker rejects unapproved axiom
declarations and theorem dependencies; `propext` and `Quot.sound` are permitted
Lean built-ins. See [the hook instructions](../../scripts/README.md).

Each suite maintains a separate `required-theorems.lean` file containing the
required theorem names and their expected proposition types; the authentication
suite's requirements are [here](../../spec/formal/auth/required-theorems.lean).
The shared checker uses Lean's definitional equality to compare each named
theorem's full type with its recorded proposition. It rejects a missing theorem
or a replacement with an axiom or definition, and checks the expected number
of distinct obligations. The checker tests
exercise missing and weakened theorems, missing or duplicate requirements, and
unapproved axioms. These requirements refer to definitions in the model: a
change to a definition can change a proposition's meaning without changing its
recorded type. Review the model definitions, requirements, and real-code
correspondence together; these checks do not prove implementation refinement.

The initial check was exercised against separate scratch regressions in the
token prefix, session mapping, expiry, revocation, suspension and closure
checks, as well as the provisional-assurance check, member role, project state,
and project expiry boundary. Each produced a failing correspondence assertion.
The original source was restored and the check passed again. Repeat these
controls in isolated source copies with
`python3 spec/formal/auth/negative-controls.py`; see the
[negative-control instructions](../../spec/formal/auth/NEGATIVE-CONTROLS.md)
and [`verify-auth-formal` skill](../../skills/verify-auth-formal/SKILL.md).

For each new or changed security property, record a stable ID, its precise
requirement and threat, normative source, implementation symbols, assumptions,
formal theorem or model-check property, real-code evidence, review revision,
and status. Mark a property **unproved** until the relevant check has actually
run and its relationship to the implementation has been reviewed. A test, a
compiler-visible token, and a Lean theorem establish different things.

## Other authentication and authorization areas

These are existing specifications and implementation starting points, not a
claim of exhaustive inventory or Lean coverage:

| Area and source | Implementation starting point | Formal status in this register |
|---|---|---|
| Federated sign-in. [Contract](../architecture/federated-signin.md). | [`federated-pending.ts`](../../packages/control-plane/src/interactions/federated-pending.ts) and [`interactions.ts`](../../packages/control-plane/src/routes/interactions.ts). | [FED-I1–I3](../../spec/formal/oauth/README.md) model signed pending-cookie binding, legacy provenance (now refused outright, a conservative refinement), and matching current trust. FED-I4, MAC verification before any parsing, unsealing or key derivation with no slow KDF on cookie input, is proved of the decoder step model and checked against `decodePending` on 160 Lean-generated cases, including derivation counts. 2026-11-24: FED-I4 is also **proved for the real `decodeSigned` statement order**: the source translator (`spec/auth-verification/source/federated-pending.mjs`) derives the function's guard/work/accept program from its own statements, one fact per guard, and Lean proves it equals the independent FED-I4 policy for all 256 fact combinations (`pending_decode_refines_policy`, `pending_decode_mac_first`, `pending_decode_bad_tag_no_work`, `pending_decode_accept_requires_tag`, `pending_decode_no_slow_hash`); `verify:oauth-formal` runs it, and dropping a guard, parsing before the MAC or adding scrypt is rejected by Lean. The translator's statement recognition and Boolean abstraction are trusted, and HMAC, AES-GCM, JSON and base64url remain assumptions. They do not prove PKCE, redirects, tokens, or protocol compliance. |
| Interaction approval binding. [ADR 0084](../adr/0084-external-authorization-notifications.md). | [`interaction.ts`](../../packages/os-domain/src/machines/interaction.ts). | [APR-B1–B5](../../spec/formal/webauthn/README.md) model digest binding, expiry, lifecycle, and sequential consumption. WebAuthn cryptography and concurrent storage are outside the model. |
| CLI app-integration assertion origin and presence. [CLI-WA1](#cli-wa1-cli-assertion-origin-and-presence). | [`webauthn_assertion.rs`](../../crates/cli-app-integration/src/webauthn_assertion.rs), called for registration and approval. | **Proved** for the [Lean model](../../spec/formal/host-cli/HostCli.lean), with finite correspondence over 1,224 assertion vectors and the implementation mapped; see [CLI-WA1](#cli-wa1-cli-assertion-origin-and-presence) for the domain and limits. Separate from APR-B1–B5. |
| Identity listener trust rotation. [Operator mTLS doc](../operators/mtls.md). | [`listener.ts`](../../packages/control-plane/src/transport/listener.ts), [`request-evidence.ts`](../../packages/control-plane/src/transport/request-evidence.ts). | [IDENTITY-TLS1](#identity-tls1-stale-transport-evidence-after-trust-rotation): **proved for the model** (`AuthTransport.lean`), with exhaustive correspondence over the abstract evidence domain and reload sequences; certificate parsing, chain verification, the TLS stack and concurrency unproved. |
| CLI app-integration credential registration and retries. [CLI-WA2](#cli-wa2-cli-credential-registration-and-retries). | [`register_webauthn`](../../crates/cli-app-integration/src/pairing/binding.rs). | **Proved** for the model, with finite correspondence over 384 registrations and 512 three-step histories and the implementation mapped; see [CLI-WA2](#cli-wa2-cli-credential-registration-and-retries). Separate from APR-B1–B5. |
| CLI app-integration restricted approvals. [CLI-WA3](#cli-wa3-restricted-cli-approvals). | [`ensure`](../../crates/cli-app-integration/src/lib.rs) and [`human_proof_verify`](../../crates/cli-app-integration/src/human_proof.rs). | **Proved** for the model, with finite correspondence over 768 `ensure` and 192 proof vectors and the implementation mapped; see [CLI-WA3](#cli-wa3-restricted-cli-approvals). Separate from APR-B1–B5. |
| Interaction deadline admission. [ADR 0086](../adr/0086-wallet-native-interaction-layer.md). | [`interaction-clock.ts`](../../packages/control-plane/src/services/interaction-clock.ts) and the approval and consumption routes. | [CLOCK-1](../../spec/formal/interaction-clock/README.md) proves the sampled deadline predicate. 2026-11-24: the consume unit of work is **proved for the model and replayed against the real route**: `uowOutcome` (six application samples inside the transaction, rollback on refusal) with `uow_commit_requires_every_sample_live`, `uow_refusal_persists_nothing`, `uow_crossing_at_any_sample_refuses` and `uow_crossing_after_last_sample_commits`; all eight Lean crossings (before each sample, after the last, never) match `POST /v1/interactions/:ref/consume` on the controlled clock (status, stored status, committed fences, sample count), and three sample mutants are caught. Still not proved: database commit-time admission (`uow_crossing_after_last_sample_commits` states that a deadline passing after the last sample is committed), clock monotonicity, Postgres transaction atomicity (the replay uses the in-memory store, whose held lease survives a rollback unlike Postgres), and the approval and activation routes' storage. |
| DPoP replay cache. RFC 9449. | [`replay.rs`](../../crates/proof/src/replay.rs). | [DPOP-R1](../../spec/formal/dpop/README.md) models the single-process cache under stated clock and atomicity assumptions. 2026-11-24: **DPOP-R2**, the decoder's age window lies inside the replay window (`fresh_proof_inside_replay_window`, `fresh_replay_refused`), is **proved: Lean model + exhaustive correspondence of the real `proof_age_admits` and `proof_replay_until` over 720 `i64` boundary cases; implementation mapped** (`replay.rs`, `jwk.rs`, `validator.rs`); both new guard mutations are detected. That the decoder and validator call those functions rests on review and hashes. JWT and signature validation, key binding, `htm`/`htu`/`ath`, clock monotonicity and multi-instance caches are not proved. |
| Grant delegation and replacement. [ADR 0036](../adr/0036-coverage-guided-fuzz-and-bounded-proofs.md). | [`grant.rs`](../../crates/domain/src/grant.rs) and its validators. | [AUTH-D1–D9](../../spec/formal/authority/README.md). D1–D6 model selected attenuation checks. 2026-11-24: AUTH-D7 (every constraint dimension: validity window, assurance, authentication age, networks, audiences, parameter-rules digest, offline use, budgets and delegation depth, for a hop, a replacement and any finite chain) and AUTH-D8 (resource-selector containment, proved for all strings) are **proved: Lean model + Lean-generated correspondence against the real Rust validators, exhaustive per dimension over the model's abstract domain (1,127 constraint pairs through both `validate_attenuation` and `validate_replacement`, 361 selector and 361 pattern pairs); implementation mapped** (`grant.rs`, `grant_attenuation.rs`, `grant_budgets.rs`, `grant_lineage.rs`). AUTH-D9 (a replacement keeps the current child's audiences, scope bindings and proof key) is proved on the same terms after a fix: `validate_replacement` let a replacement clear those fences under an unrestricted parent (regressions in `grant_unit_tests.rs` fail before and pass after; no shipped endpoint reached it). 3,062 cases pass; 24 guard mutations are each detected. Outside the model: caller authentication, proof-key possession, budget spending, concurrent behavior, and the review argument that per-dimension cases with the others fixed and representative values cover the Rust conjunction for all inputs. A separate Kani harness checks a bounded interval case. |
| Host API relay organization tenant isolation. [ADR 0046](../adr/0046-relayed-execution-and-authorization-inbox.md). | [`caller_scope`](../../crates/gateway/src/routes/relay_scope.rs) scopes inspection and denial in [`relay.rs`](../../crates/gateway/src/routes/relay.rs). | **RELAY-T1** is **proved** for the [Lean model](../../spec/formal/host-cli/HostCli.lean) (`cross_tenant_refused`, `view_requires_party`, `state_change_requires_holder`, `anonymous_refused`), with finite correspondence and the implementation mapped. Sessions use their authenticated organization; operators use the bootstrap organization. Cross-organization inspection and denial return `not_found`; only the holder in the row's organization can deny a live pending request; inspection discloses only `id`, `state` and `outcome` to the holder or delegate. 1,512 Lean-generated vectors (nine callers: a session in the row's or another organization as holder, delegate or stranger, the operator in each party role, and an anonymous caller; all seven routes; two row organizations; six stored states including an unknown one; expired or live) run through the real axum handlers in [`relay_tenant_tests.rs`](../../crates/gateway/src/routes/relay_tenant_tests.rs) against a migrated in-memory SQLite store, comparing status, the exact body and the stored state afterwards. Not covered: session and operator-token authentication themselves (fixture sessions are used), a missing bootstrap or operator token, concurrent writers, and database engines other than SQLite. |
| SPIFFE identity and trust withdrawal. [ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md), [ADR 0227](../adr/0227-spiffe-withdrawal-under-ambiguous-snapshots.md). | [`source.rs`](../../crates/spiffe-source/src/source.rs), [`source_policy.rs`](../../crates/spiffe-source/src/source_policy.rs), and [`outage.rs`](../../crates/spiffe-source/src/outage.rs). | The [withdrawal model](../../spec/formal/spiffe/README.md) covers selected denial, trust-reduction, and outage-deadline decisions. It does not prove SDK behavior for arbitrary responses, implementation refinement, certificate verification, or hard real-time sink withdrawal. |
| Source-owned transport lifetime. [ADR 0227](../adr/0227-spiffe-withdrawal-under-ambiguous-snapshots.md). | [`source_lifetime.rs`](../../crates/transport-security/src/source_lifetime.rs), [`signing_fence.rs`](../../crates/transport-security/src/signing_fence.rs), [`source.rs`](../../crates/spiffe-source/src/source.rs), and the Host admission paths. | The [source-lifetime model](../../spec/formal/source-lifetime/README.md) covers selected owner, epoch, deadline, quarantine, and signer release checks. Dual-clock behavior, actual trust-bundle comparisons, scheduler timing, underlying TLS key operations, and restart persistence remain outside the Lean proof. |
| Host SPIFFE source trust selection. [ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md). | [`boot.rs`](../../crates/gateway/src/transport/boot.rs), [`source_trust_selection.rs`](../../crates/gateway/src/transport/source_trust_selection.rs). | The [selector model](../../spec/formal/source-trust-selection/README.md) proves a Boolean source-view/presence/kind/profile/domain policy; finite Rust correspondence and live TLS tests exercise the implementation. Restart persistence is addressed separately by the history suite below, under its stated assumptions; arbitrary consumers remain unproved. |
| SPIFFE peer-domain admission. [ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md). | [`svid_profile.rs`](../../crates/transport-security/src/svid_profile.rs), [`server_conn.rs`](../../crates/transport-security/src/server_conn.rs), and [`binding.rs`](../../crates/domain/src/transport/binding.rs). | The [peer-domain model](../../spec/formal/spiffe-peer-domain/README.md) covers abstract chain, domain, profile, selector and revocation decisions. Finite correspondence and live TLS-to-service admission tests exercise selected paths; certificate parsing, cryptography, concurrency and Rust refinement are unproved. |
| NATS outbound trust and rotation. [ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md). | [`nats_connect.rs`](../../crates/task-bus/src/nats_connect.rs), [`nats_transport_env.rs`](../../crates/task-bus/src/nats_transport_env.rs), [`nats_rotation.rs`](../../crates/task-bus/src/nats_rotation.rs), [`client.rs`](../../crates/transport-security/src/client.rs) and [`bounded.rs`](../../crates/transport-security/src/bounded.rs). | [NATS-T1, T2, C1, D1 and R1–R4](../../spec/formal/source-trust-selection/README.md#nats-client-trust-and-rotation) model selected trust, identity, revocation configuration, downgrade, sequential rotation, one-use handshake-gate and retry-limit properties. Finite correspondence and NATS/TLS controls exercise selected paths; identity-source provenance, cryptography and Rust/concurrent refinement remain unproved. Existing sessions and explicitly reused injected material still require trusted caller management. |
| Durable Host source-trust names. [Operator procedure](../operators/source-trust-history.md). | [`source_history.rs`](../../crates/gateway/src/transport/source_history.rs), its coordinator, source flow and stored-trust lifecycle. | The [history model](../../spec/formal/source-trust-history/README.md) passed Linux process-level checks on `b1016221`; all 11 mutation controls passed across two runs after a focused PEM witness was added. 2026-11-24: the complete suite was re-run with that witness (`npm run verify:source-history-formal` on branch `claude/proofs-remaining-2`, Linux, private Cargo target): 25 theorem signatures, the finite correspondence and 77 tests in 16 groups passed, with drift checked before and after; the reviewed `check-axioms.sh` pin, which had drifted on main after #2935 and #2936, was re-reviewed. The scratch mutation runner was not repeated (see the Cargo-suite note above), Windows-only refusal cases remain unrun, and the pre-push invocation was not repeated. It does not establish fencing of noncooperating writers, store continuity, or Rust/SQLite refinement. |
| Guest vault custody: each guest in its own isolated tomb. [ADR 0090](../adr/0090-static-frontend-complete-without-backend.md), [ADR 0091](../adr/0091-account-exits-and-unlock-ceremony.md), [ADR 0149](../adr/0149-nothing-stored-in-the-clear.md). | [`selectGuestScope` and `prepareGuestOpen`](../../packages/app-core/src/lib/vault/store-guest-material.ts), [`vfs-transient-guest.ts`](../../packages/app-core/src/lib/vfs-transient-guest.ts), [`promoteGuestVault`](../../packages/app-core/src/lib/vault/guest-vault-promotion.ts), [`vfs-guest-deletion.ts`](../../packages/app-core/src/lib/vfs-guest-deletion.ts) and [`publishOriginalHeader`](../../packages/app-core/src/lib/vault/store-header-publication.ts). | **GUEST-V1**: the modelled storage logic is **proved for the model and checked against the implementation on every model case; implementation mapped** ([`spec/formal/guest`](../../spec/formal/guest/README.md), registry suite `guest`); the requirement as a whole stays **unproved** (limits below). Opening a guest never wipes another guest's vault: every fresh guest opens a new `guest_<uuid>` tomb under an exclusive guest lease, and a duress decoy runs in the scratch tomb, where no header (so no PIN, password or passkey) can be published. An unprotected guest's ciphertext stays in the document (never registered, never in OPFS or a file store); enrolling a factor promotes it with a registry reservation, a recovery manifest and the header written last, and an interrupted promotion is verified or discarded only under the exclusive lease. A protected guest journals each deletion before the unlink. The guest's person is sealed in its own tomb and becomes the tab actor only with that vault open, so a temporary guest no longer replaces a protected guest's actor, and a device keeps several protected guest vaults. Vitest regressions only: [`store.guest-gates.test.ts`](../../packages/app-core/src/lib/vault/store.guest-gates.test.ts), [`store-guest-lease.test.ts`](../../packages/app-core/src/lib/vault/store-guest-lease.test.ts), [`store-guest-promotion-races.test.ts`](../../packages/app-core/src/lib/vault/store-guest-promotion-races.test.ts), [`store-guest-delete-race.test.ts`](../../packages/app-core/src/lib/vault/store-guest-delete-race.test.ts), [`guest-vault-recovery.test.ts`](../../packages/app-core/src/lib/vault/guest-vault-recovery.test.ts), [`vfs-guest-deletion.test.ts`](../../packages/app-core/src/lib/vfs-guest-deletion.test.ts), [`vfs-guest-guard.test.ts`](../../packages/app-core/src/lib/vfs-guest-guard.test.ts), [`vfs-registry-protected.test.ts`](../../packages/app-core/src/lib/vfs-registry-protected.test.ts) and [`transient-guest.test.ts`](../../packages/app-core/src/lib/secret-fs/transient-guest.test.ts) (2026-11-23: all fail on main and pass with the isolated-tomb port from #2586). The vault snapshot's `tomb` is the tomb actually open; only display and road identity read the `presentedTomb` alias: [`ImportedConnectors.temporary-guest.test.tsx`](../../apps/pages/src/sections/connections/ImportedConnectors.temporary-guest.test.tsx). A guest's GitHub App key is sealed in that guest's own vault and a callback is accepted only by the same guest tomb and person: [`github-app-registration.test.ts`](../../packages/app-core/src/lib/github-app-registration.test.ts) (2026-11-23: the six guest cases fail on main and pass with the fix). Lean: `fresh_guest_never_wipes_another`, `blocked_or_retired_refuses_writes`, `foreign_owner_changes_nothing`, `frozen_guest_only_recovers` (transient store, 2,197 three-step traces of 13 owner and foreign operations), `failed_open_leaves_nothing`, `decoy_never_opens_a_guest_tomb` (`prepareGuestOpen`, 10 cases), `scratch_never_gets_header` (10 publication cases), `promotion_header_last`, `interrupted_promotion_has_no_header`, `promotion_header_only_when_complete` (13 cases, each durable write interrupted before or after it lands), `deletion_journals_before_unlink` (5 cases, each guarded effect interrupted); seven negative controls are each detected. The tab actor is not modelled. Not covered: promotion is not a cross-process transaction, cross-tab exclusivity needs shared Web Locks, the guest-return continuation and sign-out barrier of #2586 are not ported (its final code never issues a continuation), and a file-backed store cannot protect a temporary guest. |
| Staged connector credentials across sessions. [ADR 0115](../adr/0115-front-door-and-connector-directory.md). | [`sealPendingConnectorDirectory`](../../packages/app-core/src/lib/connector-directory.ts) and [`hydrateVercelConnectAuth`](../../packages/app-core/src/lib/vercel-connect-session.ts). | **CONN-S1** is **proved for the model and checked against the implementation on every bounded trace; implementation mapped** ([`spec/formal/guest`](../../spec/formal/guest/README.md), `staged_credential_never_crosses_sessions` via the inductive invariant `dstep_inv`, for all traces of the model). A connector directory key or Vercel Connect bearer staged before any vault is open is consumed by the first vault that opens, guest or not, and every vault lock discards it; a sync or failed write that finishes after the discard restores nothing, so one person's credential is never sealed into or armed for the next person's vault. Vitest regressions only: [`connector-directory.test.ts`](../../packages/app-core/src/lib/connector-directory.test.ts), [`vercel-connect-session.test.ts`](../../packages/app-core/src/lib/vercel-connect-session.test.ts) and the Pages connectors runtime test (2026-11-23: the new cases fail on main and pass with the fix), and Lean-generated correspondence over every enabled trace of up to six steps (1,155 directory and 1,349 Vercel traces of stage or arm, seal or hydrate, write completing or failing, lock and unlock), comparing the pending, armed and sealed credential after each step; four negative controls are each detected. A Vercel write already queued when the vault locks still lands in that vault, which belongs to the same session (the model allows it). Not covered: traces longer than six steps are covered only by the invariant proof, not by execution; a tab that is closed without locking leaves nothing to discard (the staged value is in memory only), and cross-tab handoff is not exercised. |
| Local identity directory custody. [ADR 0149](../adr/0149-nothing-stored-in-the-clear.md). | [`readLocalDirectory`](../../packages/app-core/src/lib/local-directory.ts). | **LOCAL-D1** is **proved for the model and checked against the implementation on every model case; implementation mapped** ([`spec/formal/guest`](../../spec/formal/guest/README.md), `undecryptable_directory_never_empty`, `refused_directory_never_rewritten`). A sealed identity directory (local identities and memberships) that the current key cannot open is never deleted or read as empty; the read fails closed and the ciphertext stays. Vitest regressions only: [`local-directory.test.ts`](../../packages/app-core/src/lib/local-directory.test.ts) (2026-11-23: `preserves a directory that cannot be opened with the current key` fails on main and passes with the fix); Lean-generated correspondence over six stored states (missing, valid, bad JSON, bad shape, oversize, sealed under another key) checks the read result, that `commitLocalDirectoryUnderLock` writes only after a successful read, and that refused ciphertext is unchanged; one negative control is detected. Not covered: the bytes-level parser beyond these six states, recovery of a genuinely corrupt directory, and whether every caller presents the refusal usefully. |
| Browser-extension runner origin binding. [Extension README](../../apps/browser-extension/README.md). | [`page-fns.ts`](../../apps/browser-extension/runner/page-fns.ts) checks the document origin in every page function and `submit` before touching the DOM; [`browser.ts`](../../apps/browser-extension/runner/browser.ts), [`driver.ts`](../../apps/browser-extension/runner/driver.ts) and [`tab.ts`](../../apps/browser-extension/runner/tab.ts) settle `off_origin` as a navigation failure and refuse screenshot capture. | **EXT-O1**: the page functions are **proved for the model and checked against the implementation on every model case; implementation mapped** ([`spec/formal/guest`](../../spec/formal/guest/README.md), `off_origin_page_untouched`, `moved_origin_never_filled`); the runner as a whole stays **unproved**. A runner action executes only in a document whose origin equals the run's origin; after focus moves, a changed origin throws before any read or write; `stillOf` always returns `unsupported`, so no frame is captured. Vitest regressions only: [`page-fns.test.ts`](../../apps/browser-extension/runner/page-fns.test.ts), [`page-fns-dom-depth.test.ts`](../../apps/browser-extension/runner/page-fns-dom-depth.test.ts), [`browser.test.ts`](../../apps/browser-extension/runner/browser.test.ts) and [`driver-page.test.ts`](../../apps/browser-extension/runner/driver-page.test.ts); the extension suite passed 176 tests at this change. Lean-generated correspondence runs all 8 page functions in jsdom against a matching, foreign or missing window, with and without focus moving the origin (48 cases), counting DOM reads and writes; three negative controls are each detected. The model found that `pfLayout` read the layout of a document with no window; it now refuses (2026-11-24, `page-fns.test.ts`). `browser.ts`, `driver.ts`, `tab.ts` and `stillOf` are not modelled; cross-frame, redirect-race and browser-engine origin semantics are outside these tests. |

The NATS check fixes the Cargo library targets and exact test inventory, but
it does not establish the full Rust module and `include!` closure. Reviewers
must map any newly introduced implementation source before later edits can
select its proof; a refreshed source hash alone is insufficient.

**RELAY-F1 — relay execution fails closed (proved for the model; implementation mapped).** Until a holder can
re-authorize at the effect boundary, the Host must not accept new relay work,
deliver executable bytes, or approve execution. A relay-only or malformed-mode
delegation must not fall back to broker invocation. Previously approved result
reports must also be refused until current authority and result recording share
a durable transaction. Broker-mode offers, claims and delegated exercise are
temporarily refused because the stored mode has no independent authenticated
binding. [ADR 0046](../adr/0046-relayed-execution-and-authorization-inbox.md)
sets the intended contract. The gateway's `relay` and `intents_queue` routes and
the broker's `delegation_mode` parser and `delegation_lineage` resolver enforce the temporary restriction;
`relay_authority_tests.rs`, `relay_tenant_tests.rs`,
`intents_relay_mode_tests.rs`, and `intents_legacy_queue_tests.rs` exercise
selected boundaries, while
`delegation_mode_tests.rs` checks malformed stored offers and delegations.
The [host-cli suite](#host-cli-suite-cli-wa1wa3-relay-t1-relay-f1) proves
`execution_routes_unavailable` (after authentication, heartbeat, submission,
the pending inbox, approval and result reporting return 501 and change
nothing), `unknown_mode_has_no_authority`, `broker_mode_not_claimable`,
`delegated_invoke_never_executes` and `relay_only_never_falls_back` of the
model. The 1,512 relay vectors exercise the five execution routes through the
real handlers. Seven stored-mode vectors (`relay`, `broker`, `Relay`, `BROKER`,
` relay`, the empty string and `unknown`) run against the real
`parse_execution_mode`, offer minting, a claim of an offer item rewritten to
that value, `find_live_delegation_by_id` on a delegation rewritten to it, and
the gateway's delegated invoke route, which must answer 501, 503 or 404 with no
invocation row. Not covered: `intents_queue::reauthorize` at the side-effect
boundary (on the delegated invoke route `delegate_invocation` refuses first,
and the existing hold-and-drain regressions remain its evidence), the bootstrap
child-grant gate (existing regression only), and stored values other than the
seven classes. The `delegation_lineage` guard that maps an unknown stored mode
to no delegation is backed by the parser: removing the guard alone still fails
closed with an error, so no control targets it separately.
The restriction cannot recall previously disclosed requests or cancel effects
already started. Restoring relay requires a separate holder-side authority fence.

### CLI-WA1: CLI assertion origin and presence

For a CLI app-integration assertion, the signed client data must name the exact
origin bound to the pairing and must not describe a cross-origin ceremony. The
signed authenticator data must contain the SHA-256 hash of that origin's
hostname as RP ID and have both user-presence and user-verification flags set.
This applies when attaching a credential and when approving a CLI request. It
prevents accepting an otherwise valid assertion for another origin or RP, or
one missing those flags. The relevant requirements are in
[WebAuthn assertion verification](https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion)
and [authenticator data](https://www.w3.org/TR/webauthn-3/#sec-authenticator-data).

[`verify_passkey_assertion`](../../crates/cli-app-integration/src/webauthn_assertion.rs)
checks these fields along with the challenge, signature and counter. Pairing
supplies the expected origin, while Pages requests its hostname as the RP ID.
This assumes the pairing and authenticator are trustworthy: client-supplied
key material and flags do not establish authenticator provenance or hardware
attestation. The current registration requests no attestation. A client-supplied
`passkey` label is not evidence of hardware provenance.

Formal status: **proved for the model, with finite correspondence; implementation
mapped**. The [host-cli suite](#host-cli-suite-cli-wa1wa3-relay-t1-relay-f1)
models the verifier as the conjunction of its comparisons and proves
`assertion_requires_exact_origin` (type `webauthn.get`, exact origin, no
cross-origin ceremony, no foreign `topOrigin`),
`assertion_requires_rp_and_presence` (pairable stored origin, RP hash, UP, UV,
37-byte authenticator data), `assertion_binds_challenge_and_key`,
`assertion_counter_advances` and `exact_present_assertion_accepted`. 1,224
Lean-generated vectors are signed with a real P-256 key and passed to the real
`verify_passkey_assertion`: all 1,152 combinations of client type, origin,
`crossOrigin` (absent, false, true), `topOrigin` (absent, same, foreign),
pairable stored origin, RP hash, UP, UV and authenticator-data length, and all
72 combinations of credential id, challenge, signature validity and
(count, stored count) in {0, 1, 2}². The two families are not crossed with each
other. The model abstracts base64, JSON and P-256 to comparison results, so
parser edge cases (duplicate keys, alternative encodings, other flag bits) and
signature security are outside it. The signed-fixture tests in
[`webauthn_assertion_tests.rs`](../../crates/cli-app-integration/src/webauthn_assertion_tests.rs)
still cover registration and approval call sites. None of this proves
authenticator provenance.

### CLI-WA2: CLI credential registration and retries

For one live pairing bearer, a verified registration may attach a credential
only when none is attached. A subsequent verified retry must name the same
credential ID and public key and cannot lower the highest observed sign count;
a different credential requires a new operator-armed pairing. This prevents a
replayed registration from rolling back the counter and a bearer holder from
replacing an already attached key. The requirement extends the registration
boundary in [ADR 0206](../adr/0206-device-key-trust-d7-2.md); WebAuthn's
[assertion verification](https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion)
describes sign-count handling.

[`register_webauthn`](../../crates/cli-app-integration/src/pairing/binding.rs)
checks the credential identity, verifies the assertion, and updates the maximum
count while holding mutable access to the pairing store. Daemon callers hold
the same mutex used for approval and counter updates. The protection lasts only
for the in-memory pairing and does not authenticate the first key or provide
hardware attestation; counterless authenticators cannot provide clone detection
through the counter.

Formal status: **proved for the model, with finite correspondence; implementation
mapped**. The model proves `register_never_replaces`,
`register_attaches_only_verified`, `register_failure_is_inert` and
`history_keeps_credential`: over any finite history of registrations and
approval counter advances, an attached credential's id and key never change
and its highest observed count never falls. 384 single-step vectors (no
credential or one with count 0, 1 or 2; found or unknown bearer; matching or
other vault digest; two credential ids; two keys and the pairing device key;
an unverifiable assertion or counts 0, 1 and 2) and 512 three-step histories
over five registrations and three counter advances run against the real
`register_webauthn` and `advance_webauthn_sign_count`. The model assumes the
root key is enrolled and every shape check passes; it does not model the daemon
mutex, persistence, or the authenticity of the first key. Signed cases in
[`webauthn_registration_tests.rs`](../../crates/cli-app-integration/src/webauthn_registration_tests.rs)
also exercise re-pairing.

### IDENTITY-TLS1: stale transport evidence after trust rotation

After the Identity listener reloads client CA, originating trust, or service
bindings, established socket peer evidence and already-buffered request evidence
must not authorize new operations. Trusted ingress must not act as the originating
client when forwarded evidence is missing or invalid.

Implementation: trust generation in
[`listener.ts`](../../packages/control-plane/src/transport/listener.ts);
per-request expiry in
[`request-evidence.ts`](../../packages/control-plane/src/transport/request-evidence.ts).

Model (2026-11-24, `OpenSesame.AuthPolicy.Transport` in
[`AuthTransport.lean`](../../spec/formal/auth/AuthTransport.lean)): an
`Evidence` value is the input of `recordRequestEvidence` (listener policy,
whether the trust generation is still the recorded one, a socket peer and an
originating peer each absent, usable or expired, a forwarded-evidence error,
and whether the binding set admits the acting identity). `peerView`,
`originatingView`, `admit` (with `admitService`) and `bindingPeer` follow the
source. Theorems: `stale_evidence_refused` (once the generation moves, no peer,
no originating peer, `evidence_expired` and no binding peer),
`admit_ok_requires` (admission needs current evidence, a usable acting peer, a
usable socket peer when there is one, and an admitting binding),
`ingress_never_acts_as_client` (on `trusted_ingress` the socket peer is never
the binding peer and admission needs usable originating evidence),
`forwarded_error_never_binds_peer`; and for the listener's generations
(`restart`, the socket registry and the per-request `isCurrent` capture),
`trust_change_stales` (any trust-changing reload stales everything recorded
before it, permanently) and `credential_reload_keeps_current`.

Correspondence (`session-conformance.test.ts`): 288 Lean-generated evidence
cases run the real `recordRequestEvidence`, `admit` and `bindingPeerOf` over
peers attested by the real `attestPeer` from certificates a disposable
`openssl` PKI issues, comparing both getters, the admission code and which peer
binds; 15 reload sequences (up to three reloads, each credential-only or
trust-changing) drive a real `createTransportListener`: its
`secureConnection` and `request` handlers run on a socket reported as verified,
`restartTransport` reloads rewritten binding files, and the test compares both
generations, staleness of the recorded evidence, `peerOf` and admission, and
whether the socket was closed. Negative controls `evidence-current`,
`evidence-ingress`, `binding-peer-ingress`, `listener-generation`,
`listener-registry` and `listener-request-current` are detected. `listener.ts`,
`request-evidence.ts` and `service-admission.ts` are mapped in the `auth`
registry suite.

Formal status: **proved for the model, with exhaustive correspondence over the
abstract evidence domain and reload sequences of length at most three**. The
correspondence triggers a trust change by a binding change; client-CA and
originating-trust changes take the same `trustChanged` branch and stay covered
by [`listener-rotation.test.ts`](../../packages/control-plane/src/transport/__tests__/listener-rotation.test.ts).
Unproved: certificate parsing and chain verification, `resolveOriginating`
(forwarded-header decoding and verification), the TLS handshake and session
resumption settings, socket lifetimes and concurrent requests during a reload,
and consumers other than `admit` and `bindingPeerOf`.

Fixed defect (2026-11-24, found while modelling `bindingPeerOf`): the OAuth
issuer's mTLS hook (`identityMtlsTransport` in
[`oauth-transport.ts`](../../packages/control-plane/src/transport/oauth-transport.ts))
read only the socket registry, so on a `trusted_ingress` listener
`tls_client_auth` and certificate-bound tokens used the ingress leaf as the
client certificate, whether or not the ingress forwarded verified originating
evidence. A token issued through the ingress was bound to the ingress, so any
client behind it could present it to the issuer's own protected endpoints. The
hook now receives the request (`MtlsTransport.peerOf(socket, request)`,
[`feature.ts`](../../packages/oauth-provider/src/mtls/feature.ts)) and, behind a
trusted ingress, answers with `bindingPeerOf`: the originating client, or none.
Regressions: `ingress-listener.test.ts` (the issuer sees each pooled request's
originating client and nothing without forwarded evidence) and
`mtls-feature.test.ts` (the hook passes the request); both fail before the fix.
The hook itself is outside the Lean model.

Evidence: Vitest regressions in
[`listener-rotation.test.ts`](../../packages/control-plane/src/transport/__tests__/listener-rotation.test.ts)
(client CA, binding, originating-trust, credential-only reload, stale replay).

### CLI-WA3: restricted CLI approvals

Until authenticator provenance is established, CLI app-integration must refuse
every verb, including unknown verbs, before creating or reusing an approval
session, and reject either client-supplied proof label. This prevents a
relabeled software assertion from approving plaintext reveal or command
injection. The denied response carries a reason for newer clients while
remaining a denial to older clients. A separately authorized run grant does not
use this app-approval path.

The native and TypeScript CLI clients also refuse locally before contacting a
daemon or accepting an injected approval port. This prevents an older daemon's
`approved` response from bypassing the pause when the CLI has been updated.
An old CLI paired with an old daemon still lacks this protection until at least
one side is updated.

The pause is recorded in the
[CLI integration conformance policy](../../spec/conformance/cli-app-integration.json).
The Rust session store and proof verifier apply it; the TypeScript session
model mirrors it. Tests cover signed assertions, preexisting pending requests,
prior approved sessions, unknown verbs, an old approving daemon, injected
approval ports and the refusal message. Legacy session
lifecycle and app-approved CLI process success cases remain as dormant
requirements and are exercised again only once app approval is safely restored;
startup-template unit tests remain active. Re-enablement must invalidate
existing pairings and enroll credentials under the new trust mechanism; it must
not promote an unattested key registered during the pause. The temporary
refusal must not be described as authenticator attestation.

Formal status of the Rust store and verifier: **proved for the model, with
finite correspondence; implementation mapped**. The
[host-cli suite](#host-cli-suite-cli-wa1wa3-relay-t1-relay-f1) proves
`ensure_always_denied`, `ensure_creates_and_reuses_nothing`,
`human_proof_never_verifies` and `approval_never_granted`. 768 vectors (eight
verbs including an unknown verb, the empty verb and the pin-probe verb; no,
fresh, idle-expired or hard-expired approved session; no, live or stale
pending row; denied or not; reuse; approvable) run against the real
`CliAppIntegrationStore::ensure`, checking the denial, that no request is
created or coalesced and that approved and denied state is untouched. 192
vectors (eight verbs, six proof labels, a valid or invalid signed assertion,
PIN lockout) run against `human_proof_verify` and `approve` on a pending row;
each fixture marked valid is first checked to verify on its own. The native and
TypeScript CLI refusals, the daemon's HTTP routing and the TypeScript session
model are outside this suite; their tests are listed above.

The session model abstracts token-prefix matching to a Boolean and does not
prove the security of token generation or storage. The model also omits
cryptography, request/session binding, actor-to-row
identity, the temporary-project owner fallback, concurrent changes between a
check and a write, database consistency, malformed runtime values, and the
correctness of external libraries. Existing browser, integration, adversarial,
compiler, fuzz, and Kani checks remain necessary in their own scopes.

### host-cli suite (CLI-WA1–WA3, RELAY-T1, RELAY-F1)

[`HostCli.lean`](../../spec/formal/host-cli/HostCli.lean) states the five
requirements as one Lean 4.24.0 model with 22 independently pinned obligations
in [`required-theorems.lean`](../../spec/formal/host-cli/required-theorems.lean),
no `sorry`, and only `propext` and `Quot.sound`. Its `main` emits 4,599
vectors. [`verify.sh`](../../spec/formal/host-cli/verify.sh)
(`npm run verify:host-cli-formal`) checks the axioms, the per-family vector
counts and the reviewed SHA-256 pins of the modeled guards and correspondence
harnesses, then runs eight ignored Cargo tests by exact name: five in
`opensesame-cli-app-integration`, two in `opensesame-gateway` and one in
`opensesame-connection-broker`. Each test replays its family through the real
Rust code and fails with `decision mismatch` on any divergence or with
`incomplete` on a short vector file. The runner then reruns the existing
behavior regressions under `webauthn_assertion::`, `human_proof::`,
`routes::relay::`, the relay-mode invoke tests and `delegation_mode_tests::`.
Cargo runs under the private workspace-wrapper namespace from
`formal-cargo-isolation.py`, so another worktree sharing the Cargo target cannot
supply these artifacts; the suite does not use the `formal-cargo-freshness.py`
input check and assumes a trusted toolchain and no concurrent writer to that
namespace.

`npm run verify:host-cli-formal -- --negative-controls` (or `bash
spec/formal/host-cli/verify.sh --negative-controls`) then mutates each key
guard in place, restoring the reviewed bytes on exit, and requires the named
correspondence test to fail with `decision mismatch`. The 16 controls drop the
UV flag, ignore `crossOrigin`, ignore `topOrigin`, skip the RP hash, accept an
equal counter (CLI-WA1); let a different credential id replace the attached one
and let a retry lower the count (CLI-WA2); unblock `is_approval_blocked` and
skip the blocked check in `human_proof_verify` (CLI-WA3); drop the organization
filter from inspection, the holder filter from denial, and move the operator
out of the bootstrap organization (RELAY-T1); accept a submission, let a
relay-only delegation fall through to the broker refusal, give the mode parser
a broker fallback, and make broker mode claimable (RELAY-F1). An empty vector
file and a nonexistent test name must also fail. Controls are selected
mutations, not a proof that every mutant is caught.

The implementation sources, the Cargo manifests and build scripts of the
`opensesame-gateway` closure, and the conformance policy are mapped in
`proof-registry.json`, so a change selects this suite on push. The pins in
`verify.sh` cover the modeled guard files and the correspondence harnesses;
`intents.rs`, `delegation.rs`, `middleware/auth.rs` and the route table are
mapped but not pinned. A proof of the model and finite correspondence do not
prove the whole implementation: the vectors are exhaustive only over the
abstract domains stated for each requirement, and parsing, cryptography,
concurrency, persistence and the callers outside these functions remain
outside the proof.

2026-11-24 review (branch `claude/proofs-rust`, base `960b0945`, Lean 4.24.0,
Rust 1.99.0): `npm run verify:host-cli-formal -- --negative-controls` passed:
22 obligations with only the allowed axioms, all 4,599 vectors matched, the
boundary regressions passed, and all 16 mutation controls and both runner
controls were detected. The first control run found that the relay harness
panicked on a non-JSON reply instead of reporting a mismatch; the harness now
classifies such replies. No implementation defect was found while writing the
model.

## Invocation receipt and dispatch properties

| ID | Requirement and implementation | Formal status and real-code evidence |
|---|---|---|
| INV-I1 | A retry returns a prior receipt only for the same effect and authority, after the current policy decision and checks on the supplied task and grant snapshots. [`idempotency.rs`](../../crates/broker/src/idempotency.rs) binds the request, verifies the signed, opaque receipt, and checks a keyed receipt commitment; [`invocations_finish.rs`](../../crates/storage/src/invocations_finish.rs) couples terminal state and receipt persistence in one `BEGIN IMMEDIATE` transaction that reserves the SQLite writer before reading the row, so concurrent completions serialize instead of stranding an executed invocation without its receipt. [ADR 0178](../adr/0178-authorization-checks-are-proofs-the-compiler-can-see.md) applies. | **Proved** (finite conformance) on the pinned Rust 1.99.0 toolchain: `cargo test -p opensesame-broker` (30 passed: 6 unit, 24 adversarial; retry binding, replay and recovery regressions), `cargo test -p opensesame-storage` (404 passed, 146 in the library; terminal-state/receipt coupling, `concurrent_completions_on_a_shared_file_all_settle` driving 16 completions across two pools on one file, `certmgr_pact` through migration 0060), `cargo test -p opensesame-gateway budget_retry_tests` (6 passed; concurrent owner retries). The checks sample authority and do not serialize a concurrent revocation with external execution. Retired signing keys and pre-upgrade entries fail closed for replay. 2026-11-24: the retry decision is **proved: Lean model + exhaustive correspondence over its abstract domain; implementation mapped** ([`spec/formal/invocation`](../../spec/formal/invocation/Invocation.lean), `npm run verify:invocation-formal`): `prior_requires_binding_receipt_and_policy`, `reserved_key_never_executes`, `replay_never_starts_an_invocation`, `current_denial_withholds_prior`; 36 Lean cases (invoke/replay, stored row absent, unbound, other binding or same binding, six receipt states, current allow or deny) run against the real broker on SQLite with the refusal reason compared, and seven guard mutants (fingerprint, signature, opaque result, intent commitment, idempotency commitment, current decision, replay-only) are each detected. Mapped: `crates/broker/src/idempotency.rs`, `lib.rs` and the harness. Outside: the storage lookups and signer internals (`opensesame-storage`, `opensesame-audit` are not in this single-package mapping), signature cryptography, and concurrency between the lookup and the reservation. |
| INV-O1 | Provider-controlled output, error text, digest and outcome do not enter brokered schema-6 receipts. [`lib.rs`](../../crates/broker/src/lib.rs), [`frozen.rs`](../../crates/broker/src/frozen.rs), and the host-owned connector registry implement [ADR 0150](../adr/0150-surrogate-credentials-at-the-last-hop.md). | **Proved** (finite conformance) on Rust 1.99.0: `cargo test -p opensesame-broker` (30 passed; frozen outcome and adversarial receipt regressions, including `independent_executor_outcome_is_signed_indeterminate_and_replayed`: an independent executor never runs the inert builtin mock, so its receipt always settles indeterminate), `cargo test -p opensesame-connector-host` (116 passed; connector registry and Wasm dispatch), `npx vitest run` in `packages/mcp-host` (132 passed; model-visible projection withholds provider data). Direct connector calls still reveal some outcome and resource-limit information; timing and external effects remain observable. 2026-11-24: the receipt projection is **proved for the model, with Lean-generated correspondence; implementation mapped** ([`spec/formal/invocation`](../../spec/formal/invocation/InvocationEffects.lean), `npm run verify:invocation-formal`): `o1_receipt_has_no_provider_fields`, `o1_outcome_only_from_host_mock`, `o1_withheld_receipt_ignores_provider`, `o1_schema6_signing_refuses_provider_fields`. 14 receipt cases (invoke, independent executor and frozen paths; host mock or registered connector; provider ok, not ok or error, less the four the fixtures cannot realize) run the real broker on SQLite with a provider that puts a marker in its summary, request digest and error text, and compare the signed receipt's outcome, the absence of the summary and both external digests, and the absence of the marker; 40 signing cases check that `sign_receipt` refuses a schema-6 receipt carrying a summary, a request or response digest or a non-commitment intent digest. Seven mutants are each detected: disclosure forced on in `invoke`, the independent executor, the frozen path and `permits_outcome_disclosure`; a provider-shaped request digest written into `finish_receipt`; and the summary and intent-digest clauses of `has_opaque_result` dropped. Outside the model: denied and cancelled receipts, frozen dispatch to the host mock (the frozen fixture binds a registered connector), what direct connector calls and timing reveal, and the signature and hash primitives (assumed sound). |
| INV-O2 | A schema-6 receipt commits to the original intent digest with a private per-invocation opening. The authenticated invocation or matching principal/subject and authority retry or task recovery carries the opening, including the existing operator authority; this is not session-instance isolation. A verifier must separately verify the receipt signature and protect the opening. [`receipt.rs`](../../crates/domain/src/receipt.rs), [`tasks_opening.rs`](../../crates/gateway/src/routes/tasks_opening.rs), and [ADR 0150](../adr/0150-surrogate-credentials-at-the-last-hop.md) specify the boundary. | **Proved** (finite conformance) on Rust 1.99.0: `cargo test -p opensesame-domain receipt` (10 passed), `cargo test -p opensesame-gateway opening_tests` (4 passed; recovery scoping), `cargo test -p opensesame-gateway receipts` (5 passed; legacy receipts withheld), and `npx vitest run src/receipt-opening.test.ts src/safe-json.test.ts` in `packages/api-client` (cross-language known-answer vector; integers outside the safe range survive freeze→recovery byte-exact). Recovery requires the saved freeze input and active original signing key; a saved opening remains usable with a retained public key. Generic KV and MCP interfaces do not return an opening. 2026-11-24: the signer and verifier boundary is **proved for the model, with Lean-generated correspondence; implementation mapped** ([`spec/formal/invocation`](../../spec/formal/invocation/InvocationEffects.lean), `npm run verify:invocation-formal`): `o2_opening_only_for_verified_opaque_receipt` and `o2_commitment_opens_only_original` (with `o1_schema6_signing_refuses_provider_fields`). 40 cases sign a legacy or schema-6 receipt under the active or another real `ReceiptSigner`, optionally alter a signed field, and require `open_receipt_intent` to return an opening exactly for an untampered, actively signed, opaque schema-6 receipt, whose opening then verifies the original intent digest and not another; 18 cases run `verifies_intent_opening` over the own, another invocation's and a malformed opening and the original, another and a malformed digest. Three mutants, dropping the receipt verification or the opaque check in `open_receipt_intent` or the schema check of `verifies_intent_opening`, are each detected, as are the two opaque-result mutants above. Still **unproved** (finite conformance above): the gateway's caller authentication, ownership and recovery scoping in `tasks_opening.rs` (not mapped; building the gateway is outside this suite), the TypeScript known-answer vector, and confidentiality of a released opening. The model treats commitments as injective, so binding rests on SHA-256 and HMAC collision resistance. |
| INV-D1 | Captured invocation details accompany broker-to-host and Wasm egress, and new delegated external execution is refused until durable revocation and effect dispatch are fenced together. [`invocation_binding.rs`](../../crates/connector-host/src/invocation_binding.rs), [`invocation_dispatch.rs`](../../crates/connector-host/src/invocation_dispatch.rs), and [`intents_budget.rs`](../../crates/gateway/src/routes/intents_budget.rs) implement this interim restriction. | **Proved** (finite conformance) on Rust 1.99.0: `cargo test -p opensesame-connector-host` (116 passed; binding-misuse and dispatch regressions), `cargo test -p opensesame-broker` (30 passed; delegated execution refusal and replay), `cargo test -p opensesame-gateway budget_retry_tests` (6 passed). The binding is constructible by in-process callers and is not proof of authorization. Stored-mode parsing is fail-closed; neither the snapshot nor these checks revoke a started effect. 2026-11-24: the connector-host part is **proved for the model, with Lean-generated correspondence; implementation mapped** ([`spec/formal/invocation`](../../spec/formal/invocation/InvocationEffects.lean), `npm run verify:invocation-formal`): `d1_dispatch_requires_the_captured_request`, `d1_delegated_never_reaches_a_registered_connector`, `d1_unbound_invoke_never_dispatches`, `d1_binding_refuses_inconsistent_authority`. 42 dispatch cases (bound or unbound; the exact request or one of nine single-field substitutions; owner or delegated binding; host mock or a registered connector that counts its effects and discards the binding) run `HostRuntime::invoke_bound` and `invoke`, and 8 capture cases run `InvocationBinding::from_intent`; six mutants (the resource, parameter and level checks of `assert_request`, the organization check of `from_snapshot`, the delegated refusal and the unbound refusal) are each detected. Still finite conformance only: the gateway's `ensure_effect_allowed` (`intents_budget.rs`) and the broker's `reject_delegated` path, which are not modelled. Outside: multi-field substitutions beyond the single-field cases (the theorem covers every change, the correspondence each single one), constrained-HTTP admission, and any durable revocation fence; the binding is not authorization and a started effect is not revoked. |
| INV-D2 | Owner Wasm egress ties the manifest-registered provider and policy ID to the invocation's durable connection, owner and active root grant. [`connector_egress.rs`](../../crates/gateway/src/connector_egress.rs) captures the registration identity; [`egress_json.rs`](../../crates/connection-broker/src/egress_json.rs) checks the stored row and grant before using that row for egress. | **Proved** (finite conformance) on Rust 1.99.0: `cargo test -p opensesame-gateway --features wasm-connectors connector_egress` (4 passed; owner provider substitution and unintended connections refused) and `cargo test -p opensesame-connection-broker egress` (26 passed; stored row and grant checks). Registration and row/grant checks are sampled; a later mutation or already-started network effect is outside this guarantee. 2026-11-24: the connection-broker check is **proved for the model, with Lean-generated correspondence; implementation mapped** ([`spec/formal/invocation`](../../spec/formal/invocation/InvocationEffects.lean), `npm run verify:invocation-formal`): `d2_egress_requires_owner_row_and_active_root_grant`. 34 cases (both owner entry points, `authorized_json_for_owner` and `authorized_http_for_owner`, times the exact owner egress and sixteen single-input perturbations: empty or other provider and owner, grant organization, absent or other grant connection, child or delegated-depth grant, expired or revoked grant, stored grant differing or missing, revoked or re-auth row, URL outside the egress policy) run on SQLite after a real OAuth completion against a local provider that counts requests; a perturbed grant is written back to storage so the stored-grant check cannot mask the guard under test, and egress must reach the provider exactly when the model says sent. Eleven mutants of the two duplicated guards and the row-status check are each detected. Still finite conformance only: the gateway's registration capture (`accepts_binding` and `GatewayEgress` in `connector_egress.rs`, behind the `wasm-connectors` feature), which this suite does not build. Outside: the egress URL policy (a boolean in the model), credential opening, and a row or grant change after the check. |
