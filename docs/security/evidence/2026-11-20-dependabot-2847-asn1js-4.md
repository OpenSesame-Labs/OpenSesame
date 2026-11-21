# Dependabot #2847 — asn1js 3.1.0 → 4.0.0 on the SWA 14 / Peculiar 3.x hoist (PR #2861)

Date: 2026-11-21. Branch: `cursor/dependabot-2847-asn1js-dd2c`, rebased onto
post-#2860 `origin/main` (`2c2f3635c2cd71ba860c36d43cfccba7a4db05d7`, which is
also the merge-base; the pre-rebase head sat on post-#2859 main
`51809907c3f6914142d247b68d1ce0a7f607a98b`, and the earliest pre-rebase history
sat on `f26e3ce34f4e44c318c6dc1e82f693b7b6e39fad`). Council head for this
revision: the single commit this rebase produces on this branch (message
`fix(deps): rebase dependabot-2847 onto main after #2860`); it supersedes prior
council heads `edb3241ac` (`fix(deps): rebase dependabot-2847 asn1js onto main
after #2859`, whose delta against `51809907c` carried the proofs that closed
chunks 01/03 below), `2c47f3a7a` (`fix(deps): sync lockfile and asn1js peer
proof for council (#2861)`, at which chunks 01/03 below were closed) and
`699e246de70b7dede0e52ba3af0d94bf7d5dcb15` (at which they were raised). A
commit cannot embed its own hash, so the new head is identified by its unique
message and the exact delta enumerated in the anchor section; resolve it with
`git log --format=%H -1 --grep="rebase dependabot-2847 onto main after #2860" cursor/dependabot-2847-asn1js-dd2c`.
Verifying runtime: Node v24.22.2 / npm 11.19.1 (repo `packageManager` pin).
This document contains no secrets, tokens, or credential material.

## What changed

Relative to merge-base `2c2f3635c` (#2860). #2860 already landed on main the
`@peculiar/x509` 3.1.0 hoist this branch had to carry while it sat on #2859 —
the blanket `@peculiar/asn1-*` 3.0.0 / `asn1js` 4.0.0 / `@peculiar/x509` 3.1.0
/ `@peculiar/utils` 4.1.1 root overrides, the
`packages/app-core/package.json` (`@peculiar/x509` 3.1.0 + `verify:x509-3`) and
`packages/auth-upstream/package.json` (`asn1js` 4.0.0) manifest pins, the
refreshed `saml-browser-crypto.mjs` digests, the regenerated lockfile, and both
exposure-matrix fingerprint rotations. This rebase drops those now-duplicate
hunks and keeps only the #2861 deltas:

| File | Change |
| --- | --- |
| `apps/pages/scripts/saml-peer-ownership.test.mjs` | The ASN.1 registry proof (chunk 01): `realpathSync` identity for one physical `asn1js` registry across the `upstream`, `core`, and `simplewebauthn` resolvers after the version checks. Everything else in the file is #2860's reviewed state, including its workspace↔core realpath-parity loop over the `@peculiar/*` family |
| `package.json` (root) | `verify:deps-2847-asn1js` (WebAuthn + pages pin gates + auth-upstream tests, same shape as #2860's `verify:deps-2846-webauthn`, alphabetized directly after it) |
| this evidence doc | Records the fresh command output at the new head |

Nothing else differs from #2860's tree. `package-lock.json` is byte-identical
to main's (which additionally carries #2860's `tools/mock-upstream-idp` →
`reflect-metadata` edge; `diff` against the pre-rebase head's lockfile shows
exactly that one added line), both manifests are main's reviewed bytes, and the
exposure matrix therefore keeps main's fingerprints (the `84a960cb…` set for
`packages/app-core/package.json`, the `506f514e…` set for
`packages/auth-upstream/package.json`) — no binding changed relative to #2860,
so there is no fingerprint rotation and no review-text change; `npm run
audit:exposure` below confirms CLEAN against the merged working tree.

## Chunk 01 — the ASN.1 registry proof is a physical-identity proof again (closes the P2)

Chunks 01 and 03 are the council record closed at the prior heads; they
describe deltas taken against `51809907c` (#2859) and remain this branch's
history. Every proof they describe is carried into the rebased tree: the
registry block below sits inside #2860's version of the test file, and the
lockfile invariant holds on main's lockfile verified fresh below.

Council finding (chunk 01, P2) at `699e246de`: the peer-ownership test asserted
`asn1js` *versions* across resolvers but not registry *identity* — separate
physical copies at 4.0.0 would still pass, while splitting the schema registry
SWA shares with app-core at runtime.

Closed. After the version checks, the test now pins one physical registry:

```js
const registry = realpathSync(core.resolve("asn1js"));
expect(realpathSync(upstream.resolve("asn1js"))).toBe(registry);
expect(realpathSync(simplewebauthn.resolve("asn1js"))).toBe(registry);
```

— the same pattern the existing `@peculiar/asn1-schema` realpath checks use.
Workspace↔core `@peculiar/x509` realpath parity is also in place (asserted
directly before the registry block, and per member inside #2860's loop): the
hoisted tree **does** allow it (the blanket override hoists `@peculiar/x509@3.1.0`
to the workspace root, resolved from the root manifest), so the strongest form
is in place and no weaker fallback or documented exception is needed:

```js
expect(realpathSync(core.resolve("@peculiar/x509"))).toBe(
  realpathSync(workspace.resolve("@peculiar/x509")),
);
```

The lockfile regeneration strengthens the same invariant from the install side:
the prior head carried eight nested `@peculiar/*` entries under
`@simplewebauthn/server` (a second physical stack, including `asn1-ecc`/`asn1-rsa`
3.1.0 copies that overrode nothing and could not satisfy their own `^3.1.0`
edges). The regenerated tree has zero entries nested under
`@simplewebauthn/server` — one hoisted stack, every member at its override
version. The test passes on a clean `npm ci` install of that tree (output
below).

## Chunk 03 — lockfile installs clean; missing `minimatch@11.0.9` restored; SWA scoped override dropped (closes the P0/P1)

Council finding (chunk 03, P0/P1) at `699e246de`: `npm ci` failed with
`Missing: minimatch@11.0.9 from lock file`; the lockfile was to be regenerated
with a root `npm install`, the redundant nested `@simplewebauthn/server`
override block dropped, and fresh evidence recorded at the new head.

Root cause and fix, not just the re-run: the prior head's lockfile had lost the
hoisted `node_modules/minimatch` entry that the
`"glob@14.0.6": { "minimatch": "$minimatch11-patched" }` override yields
(`glob@14.0.6` depends on `minimatch ^11.0.5`; the override redirects that edge
to the vendored `file:patches/vendor/minimatch-11.0.9.tgz`, which
`origin/main`'s lockfile carries at the hoisted position). Regeneration
restored exactly that entry — the same vendor tarball, same integrity, same
position as `origin/main` — and `npm ci` validates and installs it:

```text
$ npm ci
added 1936 packages, and audited 2011 packages in 24s
```

exit 0, executed 2026-11-21 on the working tree that became the pre-rebase
head, and re-verified byte-for-byte at the rebased head below (same counts,
exit 0; repo `ignore-scripts=true` policy). The nested `@simplewebauthn/server`
override block was dropped before regeneration: the blanket
`@peculiar/*` / `asn1js` overrides cover SWA's declared `^2.x` ranges, matching
#2846's intent without stacking on its branch. Full `npm ls` output at the
prior head, exit 0, no invalid/missing markers, everything deduped or
overridden —

```text
$ npm ls @simplewebauthn/server asn1js @peculiar/x509
opensesame@ /workspace/work/wt-2861
├─┬ @opensesame/app-core@0.1.0 -> ./packages/app-core
│ ├─┬ @peculiar/asn1-schema@3.0.0 overridden
│ │ └── asn1js@4.0.0 deduped
│ ├── @peculiar/x509@3.1.0 overridden
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
  ├─┬ @peculiar/asn1-x509@3.0.0 overridden
  │ └── asn1js@4.0.0 deduped
  └── @peculiar/x509@3.1.0 deduped
```

One lockfile-regeneration note, stated openly: an intermediate regeneration
seeded only from the prior head's lockfile backfilled the missing minimatch
entry from the registry and kept a nested second ASN.1 stack under SWA. The
committed lockfile is the one `npm install` recomputes and keeps (verified
idempotent: a follow-up `npm install --package-lock-only` produces a byte-identical
file), with the vendor-tarball minimatch entry and zero SWA-nested ASN.1
entries.

## Verification block (all executed 2026-11-21 on the tree that became the rebase head)

| Command | Result |
| --- | --- |
| `npm ci` | exit 0 — `added 1936 packages, and audited 2011 packages in 20s` |
| `npm ls @simplewebauthn/server asn1js @peculiar/x509` | exit 0 — the tree printed in chunk 03, reproduced identically on the merged tree: one hoisted ASN.1 stack, every member `overridden` or `deduped`, no invalid/missing markers |
| `npm run verify:deps-2847-asn1js` | exit 0 — pages pin gates `Test Files 2 passed (2)`, `Tests 7 passed (7)` (saml-peer-ownership with the registry-identity assertions merged into #2860's file + webauthn-browser-entry); auth-upstream `Test Files 18 passed (18)`, `Tests 109 passed (109)` |
| `npm test -w @opensesame/auth-upstream` (inside the gate above) | exit 0 — 18 files / 109 tests |
| pages pin consumers (`vitest run scripts/saml-browser-crypto.integration.test.mjs scripts/reflect-metadata-lite.test.mjs scripts/generate-saml-worker-parser.test.mjs` in `@opensesame/pages`) | exit 0 — 3 files / 25 tests; covers #2860's `saml-browser-crypto.mjs` pins against this clean-install tree |
| `npm run audit:exposure` | `exposure matrix: CLEAN (working tree; 20 surfaces, 671 reviewed sources)` — main's manifest fingerprints validate against the merged manifests, confirming no binding changed and no rotation was required |

Known environment note, disclosed rather than hidden: `npm run patches:verify`
fails in this environment with `sh: 1: babel: not found` during `npm pack` of a
patched upstream. It failed identically on `origin/main` (A/B'd in a clean
worktree of `f26e3ce34` with a fresh `npm ci`) during the prior rebase round,
so it is a pre-existing environment/tooling gap, not a regression of this
change; it is not part of this PR's gate list, and no vendor tarball or patch
changed in this rebase (the lockfile is byte-identical to main's).

## Anchor — the tree delta from merge-base `2c2f3635c` (#2860) to the rebase head

The single commit this rebase produces (`fix(deps): rebase dependabot-2847
onto main after #2860`) is the new council head and supersedes `edb3241ac`,
`2c47f3a7a` and `699e246de` above. The complete tree delta:

- path: `package.json` — added the `verify:deps-2847-asn1js` script line
  (alphabetized after #2860's `verify:deps-2846-webauthn`);
- path: `apps/pages/scripts/saml-peer-ownership.test.mjs` — the registry
  identity proof described in chunk 01, carried into #2860's version of the
  file after the `asn1js` version checks and before the `@peculiar/*` loop;
- path: `docs/security/evidence/2026-11-20-dependabot-2847-asn1js-4.md` — this
  document.

The duplicate #2860 hunks the pre-rebase head carried (blanket overrides,
manifest pins, `saml-browser-crypto.mjs` digests, lockfile, exposure-matrix
fingerprint rotations) are dropped, not carried: #2860 landed their content on
main in reviewed form. No other file differs; `git diff 2c2f3635c..<head>
--stat` reproduces exactly these three paths.
