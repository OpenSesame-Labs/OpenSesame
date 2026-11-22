# ADR 0206 — Device key trust for CLI app integration (D7-2)

- **Status:** Accepted (incremental; ARK/PAKE enrollment deferred)
- **Date:** 2026-10-15
- **Updated:** 2026-11-18 (assertion binding and registration retry)
- **Builds on:** [ADR 0186](0186-cli-app-integration-reveal.md), D7-2 research (`uploads/D7-2-DEVICE-KEY-RESEARCH.md`)
- **Threat model:** same-user local agent with operator token, forged `Origin`, self-minted keys, virtual WebAuthn, writable state dir; cannot drive the unlocked PWA UI or OS secure prompts.

## Context

Browser pairing and `humanProof` previously trusted client-supplied public keys and
auto-armed the first registration window. A same-user attacker could confirm with
its own P-256 key, register a forged passkey SPKI, and mint PIN proofs. The PWA
remains a static front end with no backend; daemon/CLI are optional. Full ARK + PAKE
enrollment is the long-term anchor but must not block the PWA-only path.

## Decision (this increment)

1. **No auto-arm** — `registration_armed` stays false after `confirm`; the host must
   call `arm_registration` (operator UDS) before `exchange` when no paired pages exist.
2. **No client-supplied WebAuthn SPKI alone** — `register_webauthn` (main #1356)
   requires the vault session root digest and a passkey assertion over the
   register challenge, and rejects an SPKI equal to the pairing device key;
   test seam `register_webauthn_for_tests` only bypasses that proof in tests.
   The credential ID and key cannot be replaced for the same bearer. A verified
   retry for that credential keeps the highest observed sign count; use a new
   operator-armed pairing to attach a different credential. This checks signed
   assertions, not hardware provenance: registration requests no attestation.
3. **`humanProof` v3 only** — wire prefix `oschip3:`; `oschip1`/`oschip2` rejected.
   PIN (`pin:`) proofs never verify against the client-chosen pairing device
   key (main #1366). CLI app approvals are paused until the passkey's
   authenticator provenance can be verified.
   Challenge binds `daemon_integration_id`, request id, terminal session, nonce, verb,
   `argv_hash`, and kernel-reported `peer_pid` / `peer_start_time`.
4. **Socket-only approvals** — pending rows from non-UDS ensure set `approvable: false`;
   browser `respond` cannot approve them (`wrongSession`).
5. **Ambiguous pending refused** — more than one pending integration request
   clears the queue (main #1366), superseding this branch's one-request cap.
6. **Passkey precedence and paused approvals** — PIN/`ARK`-style device-key
   proofs are rejected for approve. All CLI app-integration approvals are
   temporarily refused even for a signed passkey assertion: the client-chosen
   label cannot establish authenticator provenance. Existing terminal sessions
   and unknown verbs cannot bypass the pause.
7. **Trust store skeleton** — `TrustStore` version 3 in memory; `wipe_legacy_pairings_on_trust_upgrade`
   clears in-memory pairings (persisted authenticated store + epoch: follow-up).
8. **Headless enrollment policy** — `refuse_tty_enrollment_without_opt_in()` unless
   `OPENSESAME_CLI_APP_ALLOW_TTY_ENROLL=1` and daemon holds no secrets yet (module
   `headless_policy.rs`; CLI enroll wiring deferred).

## Adversarial review (research claims vs code at this increment)

| Finding | Verdict | Notes |
|--------|---------|-------|
| (a) pty/tty + first-come enrollment | **Mitigated partially** | Auto-arm removed; attacker still wins race if host never arms and human exchanges without registration discipline. PAKE/ARK not shipped. |
| (b) same-user writable daemon store | **Accepted risk** | Daemon cannot be the sole secret custodian; release must stay in unlocked app. Persisted MAC’d trust store not yet implemented. |
| (c) origin from enroll request | **Open** | Pairing still binds page-declared origin; allowlist at PAKE `/enroll` deferred. |
| (d) enrollment slot squatting | **Mitigated partially** | Operator must arm registration; open PAKE slot not implemented. |
| (e) attacker-controlled argv in UI | **Mitigated partially** | v3 binds `argv_hash`; daemon ensure still sends placeholder `"00"` until argv capture lands. Show secret names + terminal code: UI follow-up. |
| (f) post-approval argv / env via `/proc` | **Open** | Daemon-launched commands and env delivery documentation deferred. |
| (g) downgrade / rollback | **Partial** | Legacy proof prefixes rejected; in-memory wipe helper; no disk epoch yet. |
| (h) pinning `D_pub` alone | **Open** | SAS + alarm in PWA not implemented. |
| (i) transcript SAS | **Open** | Deferred with ARK enrollment UI. |
| (j) PWA origin / rpId | **Mitigated partially** | Assertions must carry the paired origin, the hostname RP ID hash and UP/UV flags; this assumes a trustworthy pairing and authenticator and does not attest hardware. |
| (k) loopback from HTTPS PWA | **Documented** | `localNetworkFetch` + deployment fence; Safari/Chrome may prompt or block — operator must use same deployment origin as paired page. |

## Consequences

- Pages mint `oschip3` proofs using `daemonIntegrationId` and peer fields from
  `GET …/pending`.
- Existing paired browsers continue to work until trust upgrade wipe is invoked on
  persisted format bump (today: test-only `wipe_legacy_pairings_on_trust_upgrade`).
- Full ARK/PAKE, authenticated trust store, daemon-verified WebAuthn registration, and
  headless enroll CLI remain follow-ups and must not be required for static PWA use.
- CLI calls requiring app-integration approval, including direct plaintext
  reveal, `run`, `env run`, and password-store reveal, are unavailable until a
  trusted authenticator provenance mechanism is implemented and reviewed.
  Separately authorized run grants are outside this app-approval path.

## Provenance

Implemented with **Cursor (tier 3)**; Grok Build and Kimi were unavailable on the VM.
