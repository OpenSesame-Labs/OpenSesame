# Guest admission, guest vault custody, staged credentials, local directory and runner origin

`GuestContract.lean` and its continuation `CustodyContract.lean` (checked as one
model) model the decision logic of the browser code behind AUTH-C1, GUEST-V1,
CONN-S1, LOCAL-D1 and EXT-O1 in the
[register](../../../docs/security/formal-auth-verification.md). Every await
boundary the code re-checks is an explicit input or step of the model. `main`
prints the model's answer for every case of each finite domain, and the two
conformance tests replay each vector against the real functions through their
existing test seams (`guestAuthDependencies`, host ports, `kvSeams`,
`vfsSeams`, `browserPairingSeams`, `connectorDirectorySeams`, a stubbed
`fetch`, a jsdom page); no module is mocked. Exact agreement is required.

| ID | Implementation | Lean theorems | Correspondence (all Lean-generated) |
|---|---|---|---|
| AUTH-C1 admission | `continueAsGuest` → `assertNoKnownRemoteSession` before the mint, after it and inside the guest-ordinal lock (`guest-auth.ts`, `local-guest.ts`) | `admitted_only_if_every_check_clear`, `session_seen_anywhere_refuses` | 82,944 cases: remote or local Identity × mint outcome × 24 observations (session none/own/other, federation, Host grant, hidden cookie) at each of the three checks; the real lock runs the third check |
| AUTH-C1 fresh mint | `connectFreshProvisional`, `mintProvisionalSession` (`identity.ts`, `identity-cookie-inspection.ts`, `identity-probe.ts`) | `fresh_adopts_only_clear`, `minted_unadopted_is_revoked`, `unknown_status_refuses` | 18 cases: cookie before × sign-out in another tab during the mint × cookie after, over stubbed HTTP; adoption, mint and bearer revocation observed |
| AUTH-C1 local-only guest | `pairedHostFetch`, `currentBrowserGrant` (`browser-pairing.ts`, `guest-session-context.ts`) | `local_only_guest_never_sends_grant`, `send_requires_last_boundary_clear`, `no_grant_reported_to_local_only_guest` | 40 cases: a local-only guest open or closed at each await boundary (3 without, 5 with a DPoP-nonce retry); grant-bearing sends counted |
| AUTH-C1 sign-out epoch | `captureSignOutEpoch`, `assertSignOutEpoch`, `readAuthGeneration`, `advanceAuthGeneration` | `commit_requires_same_generation`, `signout_during_operation_refuses`, `unreadable_generation_refuses` | 12 cases: start (0, 3, refusing store) × change (none, sign-out, lost write, refusing store) |
| GUEST-V1 transient store | `vfs-transient-guest.ts` | `fresh_guest_never_wipes_another`, `blocked_or_retired_refuses_writes`, `foreign_owner_changes_nothing`, `frozen_guest_only_recovers` | 2,197 traces: every sequence of three of 13 operations (owner and foreign) with the result and stored value after each |
| GUEST-V1 opening | `selectGuestScope`, `prepareGuestOpen` (`store-guest-material.ts`) | `failed_open_leaves_nothing`, `decoy_never_opens_a_guest_tomb` | 10 cases: decoy or guest × a check failing at each boundary; fresh tomb ids never repeat |
| GUEST-V1 header and promotion | `publishOriginalHeader`, `promoteGuestVault`, `deleteGuestFileInTurn` | `scratch_never_gets_header`, `promotion_header_last`, `interrupted_promotion_has_no_header`, `promotion_header_only_when_complete`, `deletion_journals_before_unlink` | 10 publication, 13 promotion (each durable write interrupted before or after it lands) and 5 deletion (each guarded effect interrupted) cases |
| CONN-S1 | `syncConnectorDirectory`, `sealPendingConnectorDirectory` (`connector-directory.ts`); `armVercelConnectAuth`, `hydrateVercelConnectAuth` (`vercel-connect-session.ts`) | `staged_credential_never_crosses_sessions` (via the inductive invariant `dstep_inv`) | 1,155 directory and 1,349 Vercel traces: every enabled sequence of up to six steps of stage, seal or hydrate, write completes or fails, lock, unlock; pending, armed and sealed credentials compared after each step |
| LOCAL-D1 | `readLocalDirectory`, `commitLocalDirectoryUnderLock` (`local-directory.ts`) | `undecryptable_directory_never_empty`, `refused_directory_never_rewritten` | 6 cases: missing, valid, bad JSON, bad shape, oversize, sealed under another key; the ciphertext is unchanged after a refusal |
| EXT-O1 | `page-fns.ts` page functions | `off_origin_page_untouched`, `moved_origin_never_filled` | 48 cases: 8 functions × same, other or no window × focus moving the origin; DOM reads and writes counted |

Run `npm run verify:guest-formal` (Lean 4.24.0). It checks the 27 obligations
in `required-theorems.lean`, audits axioms (only `propext` and `Quot.sound`),
replays all 87,807 vectors, requires the 13 correspondence tests to run and
pass, and compares the sources below with their reviewed blobs.
`bash spec/formal/guest/verify.sh --negative-controls` applies 26 guard
mutations (at least one per theorem family) in memory and requires each to
fail a correspondence assertion.

Found by this model: `pfLayout` skipped its origin check when the document had
no window and read the layout; it now refuses (`page-fns.test.ts`).

## Limits

This proves the models and checks the real functions on every case of the
models' finite domains; it does not prove the TypeScript for all inputs.
Outside the models: browser scheduling between the modelled boundaries, Web
Locks and cross-tab exclusivity (the tests use a single-tab lock double),
cookie delivery and the Identity server, OPFS and file-store semantics, crash
durability of each write, cryptography, the at-rest key, the UI, and whether
every caller uses these paths. AUTH-C1: the admission observations are the
values the dependencies return, not how they are computed; a sign-out whose
generation write is refused is not seen by other tabs
(`lost_signout_write_is_unseen`). GUEST-V1: the tab actor
(`actor_requires_own_open_tomb` in the earlier abstract model) is not modelled
or mapped; promotion is checked with two non-header files. CONN-S1: traces are
bounded at six steps and one tab; a Vercel write already queued when the vault
locks still lands in that vault (same session), and a tab closed without a
lock leaves nothing to discard. Every modelled lock also locks the tomb, so the
abort check after `hydrateVercelConnectAuth` reads the sealed bearer is not
exercised separately (the read itself fails), and a mint-time epoch check in
`identity.ts` is shadowed by the revision check that follows it. EXT-O1: jsdom stands in for the browser;
cross-frame, redirect-race and engine origin semantics are not modelled.

## Reviewed sources

- `packages/app-core/src/lib/guest-auth.ts`: `dfbcca45eb1dc2c9b4684bbd067a8278289b8abe`
- `packages/app-core/src/lib/local-guest.ts`: `00a08e579c3de6bfe08b6fd28abe861b7b492e0d`
- `packages/app-core/src/lib/identity.ts`: `e0485ac9d329655c7d21a69cdd0118e0a0e8c97c`
- `packages/app-core/src/lib/identity-cookie-inspection.ts`: `ea77513a3432f17079e3a950a0b0272bffb86a14`
- `packages/app-core/src/lib/identity-probe.ts`: `eeff84e7fc64eccc07426cd49cf04aca60a76364`
- `packages/app-core/src/lib/browser-pairing.ts`: `9c72b60517687770f83d778a568063d5f9b83642`
- `packages/app-core/src/lib/guest-session-context.ts`: `79d4ca094cabffb3c2a6f9122d3a3273d4386a45`
- `packages/app-core/src/lib/identity-shared-signout.ts`: `43520769f31ebcdfb74da915bf83827947994081`
- `packages/app-core/src/lib/auth-generation.ts`: `aedd30d13cc09db3ce2118e3b03b92623851bebc`
- `packages/app-core/src/lib/vfs-transient-guest.ts`: `de58fd18d8e77179197654ade71c87d622bfd5cf`
- `packages/app-core/src/lib/vault/store-guest-material.ts`: `0e0141022a7b724ab8dc206a1d1a69508b879c28`
- `packages/app-core/src/lib/vault/store-header-publication.ts`: `07824f05c3c412fb8bb30ea89717235b2fda5c2e`
- `packages/app-core/src/lib/vault/guest-vault-promotion.ts`: `56d215f445478fc3acbddc42f9ec4df8134f3401`
- `packages/app-core/src/lib/vfs-guest-deletion.ts`: `9f03267bae425d3f4d9a4501fb6f7d1857838421`
- `packages/app-core/src/lib/connector-directory.ts`: `adc8a49011d8b108964039970b82cad5d2878868`
- `packages/app-core/src/lib/vercel-connect-session.ts`: `4d745742f8e3cd33b0d20c0f4218ed13d73c352e`
- `packages/app-core/src/lib/local-directory.ts`: `14cc3ccb76b5a83917b5ec11d3d84c8fa224d4ee`
- `apps/browser-extension/runner/page-fns.ts`: `954fb854261c1257105a16c781eba66eb345ef31`
