# Dependabot — npm-minor-and-patch batch, 43 updates (PR #2855)

Date: 2026-11-21. Branch: `cursor/dependabot-sweep-batch1-dd2c`, main-based only
(merge-base with `origin/main` `51809907c3f6914142d247b68d1ce0a7f607a98b`; not
stacked on #2860 / #2861). This document records the close-out of the council
failures raised against the prior head `a34130af62c6a9e7aaa0ec907058894b832d50f6`
(lock drift, exposure matrix, evidence). A commit cannot embed its own hash, so
the new head is identified by its unique message
`fix(deps): sync lockfile and exposure for dependabot batch (#2855)`; resolve it
with
`git log --format=%H -1 --grep="sync lockfile and exposure for dependabot batch" cursor/dependabot-sweep-batch1-dd2c`.
Verifying runtime: Node v24.22.2 / npm 11.19.1 (repo `packageManager` pin).
This document contains no secrets, tokens, or credential material.

## What changed

| File | Change |
| --- | --- |
| `package-lock.json` | Regenerated with root `npm install` after the rebase; the hoisted `node_modules/minimatch` restored and pinned to `file:patches/vendor/minimatch-11.0.9.tgz` exactly as `patched-dependencies.mjs build` writes it (+17 lines total) |
| `tools/security/exposure-matrix.json` | Fingerprints rotated for the four bumped reviewed manifests only; dated review notes appended to the five bound surfaces |
| `apps/pages/scripts/vercel-oidc-namespace.mjs` | `connectPackage`/`oidcPackage` pins refreshed to the reviewed `@vercel/connect` 2.9.2 / `@vercel/oidc` 4.0.9 bytes; asserted OIDC version 4.0.7 → 4.0.9 (review in chunk 03) |
| `packages/{agent-protocols,oauth-provider,sdk-browser}/package.json`, `tools/mock-upstream-idp/package.json` | Biome 2.6.7 `files`-array reflow (formatter output only) |
| `docs/evidence/README.md` | Regenerated index (+1 deterministic row for PR #2823's directory, stale on main) |
| `package.json` | New `verify:deps-2855-npm-batch` gate |
| this evidence doc | Records the review, the executed regressions and the command output at this head |

## Rebase before anything else

The council head `a34130af6` was parented on `f26e3ce34f4e44c318c6dc1e82f693b7b6e39fad`,
two commits behind today's `origin/main` (`51809907c`): main had since gained
`cbd4aa077` "Fail closed on ambiguous SPIFFE snapshots (#2612)" and `51809907c`
"@simplewebauthn/server 14.1.0 + v14 types (Dependabot #2843) (#2859)". Any
merge of the branch in that state would have reverted both (the tree diff
against main deleted ADR 0227, `crates/spiffe-source/src/source_loop.rs`,
`runtime_spiffe_boot_tests.rs`, `spec/formal/spiffe/reviewed-sources.json`, the
`verify:simplewebauthn-v14` scripts and the v14 surface test). The branch was
therefore rebased onto `51809907c` first; the replayed Dependabot commit
(`eaadc0bda`) auto-merged, and the merged manifests keep main's SWA 14.1.0 pin,
the v14 verify scripts and the v14 surface test while carrying the batch's
better-auth bump. After the rebase the branch diff against main is exactly the
31 Dependabot files: 30 manifests plus `package-lock.json`. No file of #2612,
#2859, #2860 or #2861 is edited by this branch.

## Chunk 01 — lockfile installs clean; the vendored minimatch pin is restored (closes the P0/P1)

Council finding: `npm ci` fails `Missing: minimatch@11.0.9 from lock file`.
Reproduced at the prior head (exit 1, EUSAGE). Root cause: git's auto-merge of
`package-lock.json` during the rebase drops the hoisted `node_modules/minimatch`
entry that the `"glob@14.0.6": { "minimatch": "$minimatch11-patched" }` override
chain pins to the vendored tarball; a bare `npm install` re-adds the entry but
registry-resolved (`https://registry.npmjs.org/minimatch/-/minimatch-11.0.9.tgz`,
pristine bytes — verified against the registry's `dist.integrity`), leaving the
`glob@14.0.6` consumers running the unpatched matcher. The vendored tarball
`patches/vendor/minimatch-11.0.9.tgz` is the published 11.0.9 plus
`patches/minimatch@11.0.9.patch` (brace-expansion resource limits), so the
registry form silently loses the hardening.

Fix, not just the re-run: the lockfile was regenerated with a root
`npm install` and the hoisted entry pinned exactly as
`scripts/security/patched-dependencies.mjs build` (`pinLockfile`) writes it —
`resolved: file:patches/vendor/minimatch-11.0.9.tgz` at the committed tarball's
integrity `sha512-10Lq6xyx…YFCFSw==`, byte-identical to what `origin/main` and
`51809907c` record (the tarball hash was recomputed from the committed bytes and
compared before writing). `npm pack`-based rebuild/verify modes of that script
currently exit 127 in this environment because npm 11.19.1 runs the packed
package's `prepare` script despite `--ignore-scripts` (`sh: 1: tshy: not found`
for minimatch, `babel: not found` for an earlier selector); that defect
reproduces on `origin/main`'s tree unchanged and is out of scope for this batch.
The offline proof the repo gates on — `patched-dependencies.test.mjs` in
`npm run quality:test`, no network — passes and proves the installed tree equals
the committed patched tarballs. Every one of the 19 vendored selectors was
scanned: all lockfile copies at their pinned versions resolve to their
`file:patches/vendor/*.tgz` tarball; only the hoisted minimatch had been lost.

The regenerated + pinned lock is idempotent under `npm install` (re-run kept the
+17-line diff and the pinned entry) and installs clean:

```text
$ npm ci
added 1939 packages, and audited 2014 packages in 25s
24 packages are looking for funding…
```

The installed hoisted copy carries the patch (both `dist/commonjs/index.js` and
`dist/esm/index.js` contain the `Number.isNaN(options.braceExpandMax)`
hardening; grep count 1 in each).

## Chunk 02 — exposure matrix refreshed for the changed protected bindings only (closes the P2)

`npm run audit:exposure` at the rebased head failed EM-DRIFT on exactly four
reviewed sources — `packages/app-core/package.json`,
`packages/control-plane/package.json`, `packages/auth-upstream/package.json`,
`packages/sdk-browser/package.json` — the manifests the batch bumped. No other
binding drifted. Classification: dependency-only version bumps (app-core:
better-auth 1.7.22, jose 6.2.17, xmldsigjs/xml-core 3.1.0, hash-wasm 4.13.0,
effect 4.1.4, ai 7.0.172, @azure/msal-browser 5.29.1, @vercel/connect 2.9.2,
@scure/bip32 2.4.0, fake-indexeddb 6.2.8, @ai-sdk/provider 4.0.38;
control-plane: hono 4.13.18, @hono/node-server 2.1.8, jose 6.2.17, nodemailer
10.5.0, @electric-sql/pglite 0.5.16; auth-upstream: better-auth 1.7.22 only —
SWA stays 14.1.0 from #2859; sdk-browser: jose 6.2.17). No bound implementation
code changed.

Regressions executed per binding before rotating anything (all exit 0):

| Binding | Regressions run | Result |
| --- | --- | --- |
| hosted-secret-drop | control-plane `claims-drop-completion.security`, `claims-drop-code.security`, `claims-present`; os-domain `claim-token`, `claim-token-extended`; app-core `drop-present` (in the targeted run below) | 20 + 23 tests |
| hosted-link-key, portable-link-key | app-core `drop`, `arrival`, `link`, `stash`, `route-model`; full ceremony-kit suite (incl. `claim-link`, `claim-stash`) | 268 tests in 20 files |
| local-vault-activation | full `npm test -w @opensesame/auth-upstream` (18 files, incl. `webauthn.test.ts` and `simplewebauthn-v14-surface.test.ts`); full `npm test -w @opensesame/sdk-browser` (13 files, incl. `webauthn.test.ts`); app-core `store-unlock-activation`, `store-passkey`, `store-second-step` (in the targeted run) | 109 + 118 tests |
| native-provider-custody | sdk-browser full suite (incl. `client.test.ts`); app-core `native-bitwarden-crypto`, `native-azure-ac`, `native-api-http` (in the targeted run) | 118 + targeted run |
| targeted app-core run | 12 files: the drop/claims/vault/native files above plus `drop-present` | 161 tests in 12 files |

Totals: 68 files, 699 tests, 0 failures. Also run by name:
`npm run verify:simplewebauthn-v14` — 13 tests in 2 files, exit 0.

Then, and only then, the four fingerprints were rotated to the SHA-256 of the
reviewed manifest bytes (`99bc033a…f4e7d29e` app-core, `ec042d86…963314d7`
control-plane, `cccfa1aa…63d92ebb` auth-upstream, `2ba86b53…daf6a788`
sdk-browser — sdk-browser rotated twice: once for the jose bump, then again
after the Biome 2.6.7 formatter change below reflowed its `files` array) and
dated review notes were appended to the five bound surfaces
(hosted-secret-drop, hosted-link-key, portable-link-key,
local-vault-activation, native-provider-custody) recording the classification
and the executed regressions. No other entry in the matrix changed.

```text
$ npm run audit:exposure
exposure matrix: CLEAN (working tree; 20 surfaces, 671 reviewed sources)
```

## Chunk 03 — the @vercel/connect bump's reviewed OIDC namespace pins (found and closed during verification)

The first full `npm run quality:test` at this head failed 7 of 193 files. Six of
the seven reproduce byte-for-byte on `origin/main` (verified in a throwaway
worktree at `51809907c` with its own `npm ci`; pre-existing findings below).
The seventh —
`apps/pages/scripts/lib/tailscale-worker-graph.test.mjs > Pages build registers
the shared worker graph before Tailscale assets` — passed on main and failed
here: the Pages `vite.config.ts` loads `vercelOidcNamespace`, whose
`readOidcNamespaceInputs` pins the OIDC namespace inputs by SHA-256, and the
batch's `@vercel/connect` 2.9.0 → 2.9.2 (an app-core dependency) tripped
`OIDC namespace pin mismatch: connectPackage`.

Review before refreshing anything (both old tarballs downloaded and diffed
against the installed bytes):

- `@vercel/connect` 2.9.0 → 2.9.2: `package.json` changes exactly two lines —
  `version` and its `@vercel/oidc` dependency 4.0.7 → 4.0.9. `dist/` file
  inventory identical; `dist/index.js` byte-identical. No exports-map, peer or
  script changes.
- `@vercel/oidc` 4.0.7 → 4.0.9: `package.json` changes exactly two lines —
  `version` and its `@vercel/cli-config` dependency 0.3.7 → 0.4.0. The
  structural assertion the pin guards (`exports["."].browser ===
  "./dist/index-browser.js"`) is unchanged. `dist/` inventory identical;
  `dist/index-browser.js` and `dist/verify-vercel-oidc-token.js` are
  byte-identical — the pinned namespace sources the plugin exists to preserve.

Digest comparison confirmed the review: `oidcBrowser`, `verifier`,
`josePackage` and `joseBrowser` pins are UNCHANGED across the bump (same
bytes); only the two package.json pins change. `apps/pages/scripts/
vercel-oidc-namespace.mjs` was therefore refreshed deliberately: the
`connectPackage` and `oidcPackage` pins to the SHA-256 of the reviewed 2.9.2 /
4.0.9 bytes, and the asserted OIDC version 4.0.7 → 4.0.9. Nothing else in the
file changed. Both bound test files pass after the refresh:

```text
$ npx vitest run scripts/lib/tailscale-worker-graph.test.mjs scripts/vercel-oidc-namespace.test.mjs   # (apps/pages)
 Test Files  2 passed (2)
      Tests  32 passed (32)
```

## High-risk package resolution (`npm ls`)

The batch touches auth/crypto paths, so the hoisted stacks were checked:

```text
$ npm ls jose better-auth oidc-provider xmldsigjs xml-core @scure/bip32 nostr-tools
├─┬ @opensesame/app-core@0.1.0
│ │ ├─┬ @vercel/oidc@4.0.9
│ │ │   └── jose@5.10.0            # pre-existing nested pin of @vercel/connect, unchanged by this batch
│ │ ├── better-auth@1.7.22 deduped
│ │ ├── jose@6.2.17 deduped
│ │ ├── xml-core@3.1.0
│ │ └─┬ xmldsigjs@3.1.0
│ │   └── xml-core@3.1.0 deduped
├── @scure/bip32@2.4.0
├─┬ better-auth@1.7.22
│ ├─┬ @better-auth/core@1.7.22
│ │ │ └── jose@6.2.17 deduped
├── jose@6.2.17
├─┬ nostr-tools@2.26.0
│ └── @scure/bip32@2.0.1           # nostr-tools' own nested pin, valid
└─┬ oidc-provider@9.14.0
  └── jose@6.2.17 deduped
```

One hoisted stack per package: jose 6.2.17 deduped across every workspace
(the only other copy is @vercel/oidc's pre-existing 5.10.0), better-auth 1.7.22
deduped, oidc-provider 9.14.0, xmldsigjs/xml-core 3.1.0 deduped. Exit 0, no
invalid edges.

## Chunk 04 — Biome 2.6.7 formatter change on the touched manifests

The batch bumps `@biomejs/biome` 2.6.5 → 2.6.7; its formatter now expands
single-line `files` arrays in package.json. Four manifests the batch already
touches failed the staged-lint gate on exactly that
(`packages/agent-protocols`, `packages/oauth-provider`,
`packages/sdk-browser`, `tools/mock-upstream-idp` — all `"files": [...]`
reflows, no semantic change; verified by reading the four diffs). They were
formatted with `npx biome format --write` and `node
scripts/quality/lint-changed.mjs` now passes over all 31 changed files.
Because `packages/sdk-browser/package.json` is an exposure-matrix reviewed
source, its fingerprint was re-rotated to the formatted bytes and the two
surface review notes that cite it were extended to record the formatting step;
`npm run audit:exposure` is CLEAN against the result. `biome.json`'s
`$schema` still names 2.6.5; biome exits 0 with only an advisory migration
notice, and a config migration is deliberately left out of this lock-sync
batch.

## Root script

`package.json` gains the requested gate (it was absent):

```json
"verify:deps-2855-npm-batch": "npm ci && npm run audit:exposure && node --test scripts/security/patched-dependencies.test.mjs"
```

It proves exactly lock + exposure for this batch from a cold install: `npm ci`
proves lock↔manifest sync and installs the vendored tarballs, `audit:exposure`
proves the reviewed-binding contract, and the offline
`patched-dependencies.test.mjs` proves the installed tree equals the committed
patched tarballs (the lock regression this PR closed). The prompt's
`npm run quality:test` variant is not usable as this batch's gate because
`quality:test` is currently red on `origin/main` itself for six unrelated test
files (pre-existing findings below); the smallest scripted gate that proves
lock+exposure was used, per the task's parenthetical.

## Verification at this head

| Command | Result |
| --- | --- |
| `npm ci` (prior head, reproducing the council finding) | exit 1, `Missing: minimatch@11.0.9 from lock file` |
| `npm install` + pin | lockfile +17 lines, entry vendored, idempotent under re-run |
| `npm ci` | exit 0, 1939 packages in 25s; hoisted minimatch patched |
| `npm run audit:exposure` (before rotation) | FAIL, 4 EM-DRIFT |
| `npm run audit:exposure` (after rotation) | CLEAN, 20 surfaces, 671 reviewed sources |
| bound regressions (table above) | 699 tests, 0 failures |
| `npm run verify:simplewebauthn-v14` | 13 tests in 2 files, exit 0 |
| OIDC pin regressions (chunk 03) | 32 tests in 2 files, exit 0 |
| `npm run typecheck` | exit 0 — turbo: 73 tasks successful, 73 total |
| `node scripts/quality/docs-index.mjs` | regenerated: `docs/evidence/README.md` +1 row (see below) |
| `npm run quality:test` | exit 1 — every remaining failure is pre-existing on `origin/main` (see below); no failure is caused by this batch |

`npm audit` reports pre-existing advisories from the tree on main; none are
introduced by this batch (every bumped package satisfies the same ranges on
main).

## Pre-existing findings on `origin/main` (out of this batch's scope, reproduced for the record)

Reproduced in a throwaway worktree at `51809907c` with its own `npm ci`
(6 files failed identically there before any of this branch's changes):

1. `scripts/lib/ci-gates.test.mjs` — `verify-setup-tutorial-pause.mjs has no
   DRIVER_GATES row`: a recent `apps/pages/scripts/verify-setup-tutorial-pause.mjs`
   was added without a gates classification row.
2. `scripts/lib/ci-qualification.test.mjs` — expects `ref: ${{ inputs.source_sha }}`
   in the Dev artifact smoke job of a CD workflow; the workflow no longer
   carries it.
3. `scripts/lib/docs-index.test.mjs` — `docs/evidence/README.md` was stale on
   main (PR #2823's `user-token-fingerprint-label` evidence directory was never
   indexed). Fixed here only because this batch adds a docs change and
   `npm run docs:index` is part of it; the regenerated index is deterministic
   output and the check now passes.
4. `scripts/lib/install-mise-locked.test.mjs` — `cd-pwa-stranded-dispatch.yml
   has no coverage test`.
5. `scripts/lib/member-node-modules.test.mjs` — tracked sources exceed the
   allowed member-`node_modules` exemption lines.
6. `apps/pages/scripts/lib/capability-elided-imports.test.mjs` — elided-edge
   recording expectation mismatch.

Items 1, 2, 4, 5 and 6 remain red on main and are untouched by this batch;
they need their own slices (gates rows, workflow coverage tests, allowlist
review) and should not ride a Dependabot lock-sync PR.

## Rebase onto post-#2860 main (2026-11-21)

`origin/main` advanced to `2c2f3635c` (PR #2860, `@peculiar/x509` 3.1.0 +
exposure pin) after this batch's head was cut, and
`git merge-tree --write-tree` reported conflicts in `package-lock.json`,
`packages/app-core/package.json`, `packages/auth-upstream/package.json` and
related. The branch was rebased onto `2c2f3635c` as a single commit
`fix(deps): rebase dependabot batch onto main after #2860` (resolve it with
`git log --format=%H -1 --grep="rebase dependabot batch onto main" cursor/dependabot-sweep-batch1-dd2c`);
everything above this section describes the pre-rebase head
`6426858ea` and is retained as the record of that work.

Conflict resolution keeps both reviewed sets, nothing dropped and nothing
reverted: `packages/app-core/package.json` keeps #2860's `@peculiar/x509`
3.1.0 and `verify:x509-3` script plus the batch's `@vercel/connect` 2.9.2 /
`ai` 7.0.172 / `jose` 6.2.17 / `better-auth` 1.7.22 rows;
`packages/auth-upstream/package.json` keeps #2860's `asn1js` 4.0.0 plus the
batch's `better-auth` 1.7.22; `tools/mock-upstream-idp/package.json` keeps
#2860's `reflect-metadata` row plus the batch's `jose` 6.2.17; root
`package.json` auto-merged and keeps #2860's peculiar-family overrides and
`verify:deps-2846-webauthn` alongside the batch bumps and this batch's
`verify:deps-2855-npm-batch`. The exposure matrix keeps both dated review
trails and appends a rebase note; the `packages/app-core/package.json` and
`packages/auth-upstream/package.json` fingerprints are rotated to the combined
manifests (deterministic output of the reviewed byte merges).

One pin test needed the same reviewed refresh #2860 itself used for the OIDC
pins: `apps/pages/scripts/saml-peer-ownership.test.mjs` (new on main with
#2860, unseen by this batch's original head) asserts the XML signature peers
`xmldsigjs` resolves, and its `xml-core` expectation `3.0.0` tripped on the
batch's reviewed `xml-core`/`xmldsigjs` 3.0.0 → 3.1.0 bump. Review before
refreshing: both 3.1.0 manifests declare the identical dependency shape the
3.0.0 copies carry (`@peculiar/utils ^4.1.0` only — no new peers, no asn1js
edge), the batch evidence above already executed the ceremony-kit SAML
consumers at 3.1.0 (268 tests), and the rebased head re-ran the SAML surfaces
green (`verify:x509-3` 229/229 below). The expectation moved `3.0.0` →
`3.1.0`; every other assertion in the file (asn1js 4.0.0, pkijs 4.0.1, the
shared `@peculiar/x509`/`asn1-schema` parser dedupe with WebAuthn) holds
unchanged at the combined head. The file is not an exposure-matrix bound
source; no fingerprint or binding changed for it.

`package-lock.json` was regenerated starting from this branch's reviewed
lockfile (not main's), so the diff against the branch head is exactly the 24
`@peculiar`/`asn1js`-family entries #2860 adds — every other resolution,
including the hoisted `@ai-sdk/provider` 4.0.38, `@posthog/core` 1.67.2,
`postcss` 8.5.32, `set-cookie-parser` 3.2.2 and the vendored
`node_modules/minimatch` pin, is byte-identical to the branch head. A
regeneration from main's lockfile was rejected during the work: it re-resolved
today's latest-in-range transitives and flipped the hoisted
`@ai-sdk/provider` to 3.0.19, drifting from the reviewed tree.

Verification executed at the rebased head (Node v24.22.2 / npm 11.19.1):

| Command | Result |
| --- | --- |
| `npm ci` | exit 0, 1934 packages; lock↔manifest sync clean |
| `npm run audit:exposure` | CLEAN, 20 surfaces, 671 reviewed sources |
| `node --test scripts/security/patched-dependencies.test.mjs` | 11/11 pass (offline vendored-tarball proof) |
| `npm ls jose better-auth oidc-provider xmldsigjs xml-core @scure/bip32 @peculiar/x509 asn1js @ai-sdk/provider @vercel/connect` | one hoisted stack per package, `jose` 6.2.17 / `better-auth` 1.7.22 / `asn1js` 4.0.0 deduped everywhere, `@vercel/oidc`'s nested `jose` 5.10.0 pre-existing pin intact, exit 0 |
| `npm test -w @opensesame/auth-upstream` | 109/109 pass — the combined `asn1js` 4.0.0 + `better-auth` 1.7.22 surface neither parent head exercised |
| `npm run verify:x509-3 -w @opensesame/app-core` | 229/229 pass — `@peculiar/x509` 3.1.0 under the batch's manifest |
| `npm test -w ./tools/mock-upstream-idp` | 68/68 pass — `reflect-metadata` + `jose` 6.2.17 combined |
| `npm run verify:deps-2846-webauthn` | 7/7 + 109/109 pass after the reviewed `xml-core` pin refresh above |
| `npm run quality:test` | exit 1 — exactly the five documented pre-existing main failures above (items 1, 2, 4, 5, 6); `scripts/lib/docs-index.test.mjs` (item 3) passes via this branch's regenerated index; no failure is caused by this batch or the rebase |

