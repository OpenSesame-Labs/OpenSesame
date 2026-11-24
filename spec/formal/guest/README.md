# Guest admission and guest vault custody: abstract contracts

`GuestContract.lean` states, as small models, the properties the
[register](../../../docs/security/formal-auth-verification.md) claims for
AUTH-C1 (fresh-guest admission, the local-only guest and the sign-out epoch)
and GUEST-V1 (each guest in its own isolated tomb), and proves them of those
models. **No implementation file is mapped to this model and no executable
correspondence checks it.** It is not a registry suite, so no push selects it.
The status of each property is "contract proved (abstract model),
implementation unmapped": the theorems say the stated rule is coherent and
what it implies, not that the TypeScript follows it. The TypeScript evidence
remains the Vitest regressions named in the register.

| ID | Contract | Lean theorems | Implementation it describes (unmapped) |
|---|---|---|---|
| AUTH-C1 admission | A fresh guest is admitted only when the check before the mint, after it and inside the mint lock each see no Identity cookie, federation session, Host grant, orphan cookie or owed revocation; an unknown answer refuses. | `admitted_only_if_every_check_clear`, `session_seen_anywhere_refuses`, `unknown_status_refuses` | `assertNoKnownRemoteSession` in `guest-auth.ts` |
| AUTH-C1 local-only guest | A Host grant is sent only if no await boundary up to the send saw a local-only guest open; no grant is reported while one is open. | `local_only_guest_never_sends_grant`, `send_requires_last_boundary_clear`, `no_grant_reported_to_local_only_guest` | `browser-pairing.ts`, `guest-session-context.ts` |
| AUTH-C1 sign-out epoch | An operation commits only if the shared sign-out generation still equals the one it captured; a sign-out or an unreadable store refuses. | `commit_requires_same_generation`, `signout_during_operation_refuses`, `unreadable_generation_refuses` | `auth-generation.ts`, `identity-shared-signout.ts` |
| GUEST-V1 | Opening a fresh guest changes no other tomb; the scratch (duress decoy) tomb never gets a header; promotion writes the header last, so an interrupted promotion has none; deletion journals before it unlinks; a frozen (uncertain-commit) guest only recovers; the tab actor is a guest person only with that person's tomb open. | `fresh_guest_never_wipes_another`, `scratch_never_gets_header`, `promotion_header_last`, `interrupted_promotion_has_no_header`, `deletion_journals_before_unlink`, `frozen_guest_only_recovers`, `actor_requires_own_open_tomb` | `store-guest-material.ts`, `store-header-publication.ts`, `guest-vault-promotion.ts`, `vfs-guest-deletion.ts`, `vfs-transient-guest.ts` |

Run `npm run verify:guest-contract-formal` with Lean 4.24.0. It checks the 16
obligations in `required-theorems.lean` and audits axioms (only `propext` and
`Quot.sound`).

Not modelled: browser and storage concurrency, Web Locks, cookie delivery,
OPFS and file-store semantics, crash atomicity of each step, cryptography,
and whether every caller uses these paths. In particular the
local-only-guest theorem assumes the last check and the send are not
separated by an await, and the promotion theorems assume each step is
durable before the next begins.
