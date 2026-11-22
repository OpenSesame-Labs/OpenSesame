# Dependabot #2846 — @peculiar/x509 1.14.3 → 3.1.0, Peculiar ASN.1 3.x hoist (PR #2860, rebased onto post-#2859 main)

Date: 2026-11-21. Branch: `cursor/dependabot-2846-peculiar-dd2c`. Council head for
this revision: the single commit this rebase produces on top of `origin/main`
`51809907c3f6914142d247b68d1ce0a7f607a98b` (main after #2859 landed
`@simplewebauthn/server` 14.1.0 + v14 types), with the message
`fix(deps): rebase dependabot-2846 onto main after #2859`. A commit cannot embed
its own hash, so the new head is identified by its unique message; resolve it
with
`git log --format=%H -1 --grep="rebase dependabot-2846 onto main after #2859" cursor/dependabot-2846-peculiar-dd2c`
and reproduce the delta with `git diff 51809907c..<head> --stat`. The pre-rebase
council head was `2dbc1d25950c5bb696571e769fba8a0188c222c1d` (still the tip of
`origin/cursor/dependabot-2846-peculiar-dd2c` until this rebase is pushed); every
round before it was anchored at `f9befe5a`, `1c94eebf8`, `c624b69a`, `66069d50`,
and the rebased-away `8c40e7d0b`.

Verifying runtime: Node v24.22.2 / npm 11.19.1. It contains no secrets, tokens,
or credential material.

## Rebase onto post-#2859 main — what was dropped, what was kept

`origin/main` advanced to `51809907c` with #2859, which landed the
SimpleWebAuthn 14.1.0 migration this branch had been carrying in parallel. The
rebase onto `51809907c` therefore **dropped** the branch commits whose hunks
were already on main, and kept only the #2846 / `@peculiar/x509` 3.1.0
dependency intent:

Dropped (already on main via #2859, byte-comparable there):

- `6a94bd365` `build(deps): bump @simplewebauthn/server from 13.3.2 to 14.1.0`
  (root + auth-upstream manifests, lockfile);
- `d713dc5c3` `fix(deps): land @simplewebauthn/server 14.1.0 with SWA v14 types`
  (`packages/auth-upstream/src/webauthn.ts` rename, exposure-matrix rotation);
- `0e402549d` `fix(pages): refresh SimpleWebAuthn 14.1.0 browser entry pins` —
  the branch's four refreshed pins are a strict subset of main's #2859 version,
  which additionally pins the full static import closure;
- `04be17869` `fix(deps): pin dts-bundle-generator typescript 6.0.3 via
  override` (main's #2859 carries the same override, so no duplicate block
  remains);
- `2eec067ab` `fix(deps): dedupe dts override, drop redundant SWA scope, sync
  lockfile after main rebase` — its dedupe target no longer exists after the
  drops above, and its SWA-scope trim would have orphaned main's root
  `verify:simplewebauthn-v14` script (see below).

Kept and squashed into the single rebased commit (the #2846 intent):
`1add9ab86` (the `@peculiar/x509` 3.1.0 bump), `78bbe497b` (app-core manifest
fingerprint rotation), `982d074ca` (SAML browser crypto pins for x509 3.1.0),
`aa8008a48` + `1ac834727` (blanket Peculiar ASN.1 3.x / asn1js 4.0.0 hoist and
the 3.x saml-peer-ownership rewrite), `1d7c3b808` (formatting), `2f2a55da5`,
`26d4b1b7d`, `9d95e70e1`, `f9befe5aa`, `2dbc1d259` (evidence rounds, the mock
IdP `reflect-metadata` entry-point rewrite, the auth-upstream `asn1js` manifest
alignment, the restored physical-copy parity assertions, and the
`verify:deps-2846-webauthn` / `verify:x509-3` scripts).

Conflict resolutions, all inside `git rebase`:

- `packages/auth-upstream/src/webauthn.ts`,
  `apps/pages/scripts/webauthn-browser-entry.mjs`,
  `apps/pages/scripts/webauthn-browser-entry.test.mjs`,
  `packages/auth-upstream/src/__tests__/simplewebauthn-v14-surface.test.ts`, and
  `docs/security/evidence/2026-11-20-dependabot-2843-simplewebauthn-14.md` are
  main's #2859 versions, byte-identical — this branch no longer carries any hunk
  of them.
- `packages/auth-upstream/package.json` keeps main's
  `verify:simplewebauthn-v14` script (13 tests in 2 files, re-run below) and
  changes only `asn1js` 3.1.0 → **4.0.0**. The branch's pre-rebase alias
  `verify:swa-14` was not carried: it would have left main's root
  `verify:simplewebauthn-v14` script (`npm run verify:simplewebauthn-v14 -w
  @opensesame/auth-upstream`) pointing at a script that no longer exists.
- Root `package.json` keeps the blanket `overrides` hoist only
  (`@peculiar/asn1-*` 3.0.0, `@peculiar/x509` 3.1.0, `asn1js` 4.0.0,
  `@peculiar/utils` 4.1.1). The `@simplewebauthn/server`-scoped override block
  the intermediate branch commits had added is not carried: the pre-rebase
  `2eec067ab` round proved the scoped block byte-for-byte redundant with the
  blanket hoist, and the regenerated lockfile below (built from the blanket-only
  manifest) has a `@peculiar`/`asn1js`/`tsyringe`/`reflect-metadata` subtree
  byte-identical to the pre-rebase branch lock, which re-proves it.
- `package-lock.json` was regenerated from main's `51809907c` lockfile as the
  base (`git checkout origin/main -- package-lock.json` + one `npm install`),
  not auto-merged; the diff against main is exactly the Peculiar/asn1js family
  and `reflect-metadata` (141 insertions, 199 deletions), with no
  SimpleWebAuthn, dts-bundle-generator, or patched-tarball churn.
- `tools/security/exposure-matrix.json` starts from main's matrix (with #2859's
  review notes and the post-`cbd4aa077` fingerprints for the SPIFFE/transport
  sources this branch never touched); only the two manifest fingerprints below
  are rotated, and one dated review note is appended where main documented the
  #2859 rotations.
- The mock IdP `reflect-metadata` entry points, both pages pin-test files, and
  this doc are carried from the branch unchanged.

## What changed (complete delta vs `origin/main` `51809907c`)

| File | Change |
| --- | --- |
| `package.json` | blanket `overrides` hoist: `@peculiar/asn1-*` → 3.0.0, `@peculiar/x509` → 3.1.0, `asn1js` → 4.0.0, `@peculiar/utils` → 4.1.1; new script `verify:deps-2846-webauthn` |
| `packages/app-core/package.json` | `@peculiar/x509` 1.14.3 → 3.1.0; new script `verify:x509-3`: `vitest run src/browser/saml` |
| `packages/auth-upstream/package.json` | `asn1js` declared 3.1.0 → **4.0.0** (aligned with the hoisted copy the overrides force); scripts otherwise main's, including `verify:simplewebauthn-v14` |
| `apps/pages/scripts/saml-browser-crypto.mjs` | the two shared-certificate pins refreshed for `@peculiar/x509` 3.1.0 (manifest + implementation digests) |
| `apps/pages/scripts/saml-peer-ownership.test.mjs` | 3.x rewrite: workspace/core parity for `@peculiar/asn1-schema` 3.0.0 and `@peculiar/x509` 3.1.0, implementation-digest equality between app-core and `@simplewebauthn/server`'s resolved copy, `asn1js` 4.0.0 everywhere, and the restored physical-copy parity assertions (chunk 01) |
| `tools/mock-upstream-idp/src/cli.ts`, `src/index.ts`, `src/testkit.ts`, `src/test-setup.ts` (new), `vitest.config.ts`, `src/config.ts`, `package.json` | `import "reflect-metadata"` on the package's entry points instead of the library module `config.ts`, `reflect-metadata@0.2.2` declared — chunk 07 |
| `tools/security/exposure-matrix.json` | reviewed-source fingerprints rotated for exactly `packages/auth-upstream/package.json` and `packages/app-core/package.json`; one dated review note appended to the row that binds them (see chunk 05) |
| `package-lock.json` | regenerated from main's lockfile; Peculiar/asn1js family + `reflect-metadata` only |
| this evidence doc | re-anchored to the rebased head; fresh verification block below |

Nothing else differs from `origin/main`: `webauthn.ts`, the webauthn
browser-entry pins and their closure tests, the v14 surface test, and the #2843
evidence doc are #2859's, untouched by this branch.

## Verification (all exit 0, executed 2026-11-21 on the working tree that became the rebased head — the single commit `fix(deps): rebase dependabot-2846 onto main after #2859` on `origin/main` `51809907c`; Node v24.22.2 / npm 11.19.1)

```text
npm ci                                   # exit 0; added 1936 packages, and audited 2011 packages in 20s (9 moderate minimatch advisories, pre-existing — see Limits)
npm ls @simplewebauthn/server @peculiar/x509 @peculiar/asn1-schema @peculiar/asn1-x509 asn1js  # exit 0, tree below
node --test scripts/security/patched-dependencies.test.mjs   # tests 11, pass 11
npm exec -w @opensesame/pages -- vitest run scripts/saml-peer-ownership.test.mjs scripts/webauthn-browser-entry.test.mjs   # Test Files 2 passed (2), Tests 7 passed (7)
npm run verify:deps-2846-webauthn        # pin gates 2/7, then Test Files 18 passed (18), Tests 109 passed (109)
npm test -w @opensesame/auth-upstream    # Test Files 18 passed (18), Tests 109 passed (109)
npm run verify:simplewebauthn-v14 -w @opensesame/auth-upstream   # Test Files 2 passed (2), Tests 13 passed (13)  [main's #2859 manifest-anchored SWA v14 surface suite, still wired and green after the rebase]
npm run verify:x509-3 -w @opensesame/app-core        # Test Files 10 passed (10), Tests 229 passed (229)  [focused SAML/browser-crypto glob on the forced x509 3.1.0 stack]
npm test -w ./tools/mock-upstream-idp    # Test Files 11 passed (11), Tests 68 passed (68)
npm exec -w @opensesame/sdk-server -- vitest run src/reference-idp.integration.test.ts   # Test Files 1 passed (1), Tests 1 passed (1)  [downstream testkit consumer]
npm exec -w @opensesame/control-plane -- vitest run src/__tests__/oauth2-leg.test.ts     # Test Files 1 passed (1), Tests 20 passed (20)  [downstream testkit consumer]
npm run typecheck                        # turbo: Tasks 73 successful, 73 total (65 cached, 8 fresh)
npm run audit:exposure                   # exposure matrix: CLEAN (working tree; 20 surfaces, 671 reviewed sources)
npm run lint                             # exit 0 (repository-size, evidence, and biome changed-file gates included)
```

The pages pin-gate count moved from 5 to 7 tests because main's #2859 added two
closure assertions to `webauthn-browser-entry.test.mjs`; both files pass under
the pages vitest runner at this head (a bare `node --test` on them still exits 1
because they import `vitest` — the property recorded since the chunk 02 round).
The auth-upstream suite moved from 17/106 to 18 files / 109 tests because main's
#2859 added `simplewebauthn-v14-surface.test.ts`; the suite is green with the
`asn1js` 4.0.0 manifest pin in place.

`npm ls` output at this head (exit 0, no invalid/missing markers):

```text
opensesame@ /workspace/work/wt-2860
├─┬ @opensesame/app-core@0.1.0 -> ./packages/app-core
│ ├─┬ @peculiar/asn1-schema@3.0.0 overridden
│ │ └── asn1js@4.0.0 deduped
│ ├─┬ @peculiar/x509@3.1.0 overridden
│ │ ├─┬ @peculiar/asn1-cms@3.0.0 overridden
│ │ │ ├── @peculiar/asn1-schema@3.0.0 deduped
│ │ │ ├─┬ @peculiar/asn1-x509-attr@3.0.0 overridden
│ │ │ │ ├── @peculiar/asn1-schema@3.0.0 deduped
│ │ │ │ └── @peculiar/asn1-x509@3.0.0 deduped
│ │ │ └── @peculiar/asn1-x509@3.0.0 deduped
│ │ ├─┬ @peculiar/asn1-csr@3.0.0 overridden
│ │ │ ├── @peculiar/asn1-schema@3.0.0 deduped
│ │ │ └── @peculiar/asn1-x509@3.0.0 deduped
│ │ ├─┬ @peculiar/asn1-pkcs9@3.0.0 overridden
│ │ │ ├─┬ @peculiar/asn1-pfx@3.0.0 overridden
│ │ │ │ └── @peculiar/asn1-schema@3.0.0 deduped
│ │ │ ├─┬ @peculiar/asn1-pkcs8@3.0.0 overridden
│ │ │ │ ├── @peculiar/asn1-schema@3.0.0 deduped
│ │ │ │ └── @peculiar/asn1-x509@3.0.0 deduped
│ │ │ ├── @peculiar/asn1-schema@3.0.0 deduped
│ │ │ └── @peculiar/asn1-x509@3.0.0 deduped
│ │ ├── @peculiar/asn1-schema@3.0.0 deduped
│ │ └── @peculiar/asn1-x509@3.0.0 deduped
│ ├── asn1js@4.0.0 overridden
│ ├─┬ pkijs@4.0.1
│ │ └── asn1js@4.0.0 deduped
│ └─┬ xmldsigjs@3.0.0
│   └── asn1js@4.0.0 deduped
├─┬ @opensesame/auth-upstream@0.1.0 -> ./packages/auth-upstream
│ ├── @simplewebauthn/server@14.1.0 deduped
│ └── asn1js@4.0.0 deduped
├─┬ @opensesame/mock-upstream-idp@0.1.0 -> ./tools/mock-upstream-idp
│ └─┬ selfsigned@5.5.0
│   ├── @peculiar/x509@3.1.0 deduped
│   └─┬ pkijs@3.4.3
│     └── asn1js@4.0.0 deduped
└─┬ @simplewebauthn/server@14.1.0
  ├─┬ @peculiar/asn1-android@3.0.0 overridden
  │ └── @peculiar/asn1-schema@3.0.0 deduped
  ├─┬ @peculiar/asn1-ecc@3.0.0 overridden
  │ ├── @peculiar/asn1-schema@3.0.0 deduped
  │ └── @peculiar/asn1-x509@3.0.0 deduped
  ├─┬ @peculiar/asn1-rsa@3.0.0 overridden
  │ ├── @peculiar/asn1-schema@3.0.0 deduped
  │ └── @peculiar/asn1-x509@3.0.0 deduped
  ├── @peculiar/asn1-schema@3.0.0 deduped
  ├─┬ @peculiar/asn1-x509-post-quantum@3.0.0 overridden
  │ ├─┬ @peculiar/asn1-asym-key@3.0.0 overridden
  │ │ ├── @peculiar/asn1-schema@3.0.0 deduped
  │ │ └── @peculiar/asn1-x509@3.0.0 deduped
  │ ├── @peculiar/asn1-schema@3.0.0 deduped
  │ └── @peculiar/asn1-x509@3.0.0 deduped
  ├─┬ @peculiar/asn1-x509@3.0.0 overridden
  │ ├── @peculiar/asn1-schema@3.0.0 deduped
  │ └── asn1js@4.0.0 deduped
  └── @peculiar/x509@3.1.0 deduped
```

SWA 14.1.0's declared `^2.x` Peculiar ranges all resolve to `@3.0.0 overridden`
/ `@3.1.0 deduped` — npm itself reports the tree valid; the `overrides` pins are
how the declared ranges legally resolve to 3.x. One physical copy of each
package: no entries under `node_modules/@simplewebauthn/server/node_modules/`,
and the histogram is 13 × `@peculiar/asn1-*@3.0.0`, `@peculiar/x509@3.1.0`,
`@peculiar/utils@4.1.1`, `asn1js@4.0.0`. The "two parallel ASN.1 stacks" failure
mode stays structurally excluded.

## Council HOLD history (pre-rebase rounds — commands below were executed at their respective pre-rebase heads on `2dbc1d259` and earlier; superseded by the fresh block above, kept for the record)

The rounds below answered the council while the SWA 14.1.0 migration still lived
on this branch, before #2859 landed it on main. Where they reference
`verify:swa-14` (the pre-rebase auth-upstream alias for `vitest run`), the
rebased head uses main's `verify:simplewebauthn-v14` script plus
`npm test -w @opensesame/auth-upstream` — the same suites, re-run fresh above.

### Round 4 — chunk 01 (P2) physical-copy parity; chunk 04 (P1) manifest-anchored verify scripts

`apps/pages/scripts/saml-peer-ownership.test.mjs` carries, after
`expect(version(core, "@peculiar/x509")).toBe("3.1.0")`:

```js
expect(realpathSync(core.resolve("@peculiar/x509"))).toBe(
  realpathSync(workspace.resolve("@peculiar/x509")),
);
```

and the `@peculiar/x509` / `@peculiar/asn1-rsa` / `@peculiar/asn1-x509` /
`@peculiar/asn1-ecc` loop resolves each package from both the pages workspace
require and the app-core require and asserts the same physical copies three
ways: the package itself, its `@peculiar/asn1-schema` dependency, and its
`asn1js` dependency — alongside the retained semver assertions. A
same-version split install (two physical copies at 3.0.0/4.0.0) fails the gate
instead of passing on version strings alone. The pre-rebase round-4 run
recorded the pin gates at 2 files / 5 tests (before #2859's two closure
assertions); at the rebased head the same gate is 2 files / 7 tests (fresh block
above).

Chunk 04 anchored the migration proofs in the manifests the council reads.
Post-rebase, `verify:x509-3` (`vitest run src/browser/saml`, app-core) remains
this branch's manifest anchor; the SWA half is main's
`verify:simplewebauthn-v14` (13 tests in 2 files, re-run green above) — the
pre-rebase `verify:swa-14` alias was dropped with the rebase because main's
root script depends on the #2859 name.

### Chunk 03 — installability, declared-range fit, and the reflect polyfill

- `npm ci` against the committed lockfile (repo `ignore-scripts=true` policy)
  exits 0 (fresh block above). npm's arborist validates the lockfile verbatim;
  the `overrides` pins are how the declared `^2.x` ranges legally resolve to
  3.x, so no nested v2 copy is required — or desirable, since a second physical
  ASN.1 stack would split the schema registry SWA shares with app-core.
- One physical copy of each package; `node --test
  scripts/security/patched-dependencies.test.mjs` → 11/11 (fresh block above),
  including "the lockfile installs every copy of a patched package from its
  tarball".

The reflect polyfill, stated exactly as the council asked:

- `packages/app-core/package.json` declares `"reflect-metadata": "0.2.2"` in
  `dependencies`.
- Every module under `packages/app-core/src/browser/saml/` that imports
  `@peculiar/x509` imports `"reflect-metadata"` first, verified file by file
  (7/7) with the import physically preceding the `@peculiar/x509` import.
- `tools/mock-upstream-idp` carries the polyfill at every entry point:
  `import "reflect-metadata"` is line 1 of the process entry `src/cli.ts` and of
  the public exports `src/index.ts` and `src/testkit.ts`, and
  `src/test-setup.ts` (the same single import, loaded through `setupFiles` in
  `vitest.config.ts`) guarantees it precedes any module under test; the library
  module `src/config.ts` does not import it. The refinement is load-bearing:
  `src/testkit.ts` is a public export consumed by `packages/control-plane` and
  `packages/sdk-server` tests, and `src/testkit-environment.test.ts` spawns a
  raw `node --import tsx` child whose entry is `testkit.ts` itself. Suite at the
  rebased head: 11 files / 68 tests pass; both downstream consumers re-run green
  (fresh block above).
- `@simplewebauthn/server@14.1.0` itself declares `reflect-metadata ^0.2.2`, so
  the SWA 14 path carries the polyfill dependency in its own manifest; app-core's
  SAML modules and the mock IdP keep their own explicit first imports as defense
  in depth.

### Chunk 04 (analysis) — why the forced overrides are safe

Blast radius — grep of every workspace `package.json` for `@peculiar/`,
`asn1js`, `pkijs`, `xmldsigjs`, `selfsigned` finds exactly three first-party
consumers, all covered by the gates:

- `packages/app-core` — direct deps `@peculiar/asn1-schema@3.0.0`,
  `@peculiar/x509@3.1.0`, `asn1js@4.0.0`, `pkijs@4.0.1`, `xmldsigjs@3.0.0`,
  `xml-core@3.0.0` (SAML/browser certificate paths).
- `packages/auth-upstream` — `@simplewebauthn/server@14.1.0`, `asn1js@4.0.0`
  (declared pin equal to the forced hoisted copy; its only asn1js surface is
  the `fromBER` re-export at `packages/auth-upstream/src/asn1.ts:2`).
- `tools/mock-upstream-idp` — `selfsigned@5.5.0` (`@peculiar/x509 ^1.14.2`
  forced to 3.1.0, `pkijs ^3.3.3` at 3.4.3 with its `asn1js ^3.0.6` forced to
  4.0.0).

Why the forced set is safe:

1. **Internal consistency.** `@peculiar/x509@3.1.0` declares `^3.0.0` across
   the asn1 family and `^4.1.0` for `@peculiar/utils`;
   `@peculiar/asn1-schema@3.0.0` peers `asn1js ^4.0.0`; `asn1js@4.0.0` depends
   on `@peculiar/utils ^4.1.0`. The forced pins {13 × asn1 3.0.0, x509 3.1.0,
   utils 4.1.1, asn1js 4.0.0} satisfy every one of those declared ranges
   exactly — the single version combination in which the 3.x packages' own
   ranges all hold simultaneously, which is why a scoped, per-consumer override
   cannot work: SWA 14 and app-core must share one physical stack or the ASN.1
   schema registry splits.
2. **Beyond-range consumers were found by verification, not assumed away.** The
   council's P2 scenario materialized once: `selfsigned@5.5.0` (x509 `^1.14.2`)
   loads `tsyringe` via x509 3.1.0, and the mock IdP suites failed at import
   time ("tsyringe requires a reflect polyfill") until the entry-point polyfill
   fix landed — precisely the silent runtime break the council predicted, now
   regression-covered on every run.
3. **No silent split-brain.** `npm ls` exit 0 (tree above) proves no dependent
   resolved to an unforced version; `pkijs@3.4.3` and `pkijs@4.0.1` both dedupe
   to the single `asn1js@4.0.0`.
4. **SWA 14 migration is real and exercised** — on main via #2859 (v13→v14
   rename, pinned browser entry closure, `simplewebauthn-v14-surface.test.ts`),
   all re-run green at this head with the forced Peculiar 3.x tree underneath
   (fresh block above).

Engine requirements, re-read from the packages installed by this head's
`npm ci`:

| Package | Installed | `engines.node` | Repo pin |
| --- | --- | --- | --- |
| `@simplewebauthn/server` | 14.1.0 | `>=22.0.0` | `>=24.15.0 <25.0.0 \|\| >=26.0.0` (`package.json`), `node = "24"` (`mise.toml`) |
| `@peculiar/x509` | 3.1.0 | `^20.19.0 \|\| >=22.12.0` | same |
| `@peculiar/asn1-*` (13 packages) | 3.0.0 | `^20.19.0 \|\| >=22.12.0` | same |
| `@peculiar/utils` | 4.1.1 | `^20.19.0 \|\| >=22.12.0` | same |
| `asn1js` | 4.0.0 | `^20.19.0 \|\| >=22.12.0` | same |

Every floor is satisfied by the repo pin; the install ran clean with the repo's
`ignore-scripts=true` policy. No override touches an `engines` field. No test
was weakened and no override was removed or narrowed by the rebase; the one
override-shape change vs the pre-rebase branch state is not carrying the
redundant `@simplewebauthn/server`-scoped block, proven byte-for-byte
equivalent (lockfile identical without it, regenerated above).

### Chunk 05 — exposure-matrix rotation provenance and verification

The branch touches exactly two matrix-reviewed sources (values at the rebased
head):

- `packages/auth-upstream/package.json` — `506f514e…bdaa0054` = SHA-256 of the
  file (main's #2859 manifest + `asn1js 4.0.0`; scripts byte-identical to
  main's). Rotated for the declared-pin alignment after source review: a
  manifest change with no authority, egress, admission or
  classification-semantic change, so the bindings it participates in are
  unchanged; the full verification block above was re-run before rotating.
- `packages/app-core/package.json` — `84a960cb…1edc4235` = SHA-256 of the file
  (`@peculiar/x509` 3.1.0 manifest plus the `verify:x509-3` script line;
  content unchanged from the pre-rebase branch, hence the same digest).

No other matrix entry differs from main. `tools/mock-upstream-idp/package.json`
is not a matrix-reviewed source, and neither is the root `package.json` script
block — no fingerprint rotation was needed for either. A dated review note was
appended to the `local-vault-activation` row (where main's #2859 documented its
own manifest rotations) recording this rebase's two rotations and the executed
regressions. `npm run audit:exposure` → CLEAN (20 surfaces, 671 reviewed
sources), exit 0 (fresh block above).

## Limits

Dependency-slice review: manifest/lockfile diff, override audit, engine fit,
browser-entry and SAML pin refresh, installability and tree-shape evidence, and
the exposure-matrix bindings. It does not re-review upstream `@peculiar/x509`
3.x or SWA 14 verification internals beyond the type-level and test evidence
above, and it is not a full `npm run verify` run.

`npm audit` at this head reports 9 moderate `minimatch` advisories
(GHSA-g3hv-75wg-m249, versions 7.0.0–11.0.0). They pre-date this branch —
`origin/main` already pins `minimatch` to the reviewed patched tarballs
(`minimatch9-patched`, `minimatch11-patched`) via root overrides, this branch
does not touch them, and `npm audit fix --force` would break those pins; they
are out of scope for this dependency slice and unchanged by it.
