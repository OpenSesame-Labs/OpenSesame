# Dependency patches were declared but not installed — 2026-11-11

Four patches to third-party packages lived in `patches/` and were named in
`package.json` under `patchedDependencies`. npm does not read that field. Since
the move to npm workspaces, every install produced the packages exactly as
published. Nothing failed and nothing warned.

## What was affected

| Package | Patch | State before this change |
| --- | --- | --- |
| `@levischuck/tiny-cbor` 0.2.11 | Encode a text string by its byte length | Unpatched. A runtime dependency of `@simplewebauthn/server`, which `packages/auth-upstream` uses |
| `@simple-git/argv-parser` 2.0.1 | Reject abbreviated Git pack-executable options ([note](../../../patches/simple-git-parser-residual.md)) | Unpatched. Development only, through promptfoo |
| `js-yaml` 3.15.2 | Run the command line on argparse 2 | Unpatched, and still resolved to argparse 1.0.10, which brought `sprintf-js` 1.0.3 back into the lockfile |
| `@devicefarmer/adbkit` 3.3.8 | Load the TCP bridge and key parser lazily | No effect either way: nothing in the lockfile depends on it |

Two earlier audits describe states that no longer held under npm:

- [CLI dependency remediation, 2026-10-06](2026-10-06-password-parity-cli-dependencies.md)
  records `sprintf-js` (GHSA-hp3w-g68c-fv3c) and `argparse@1` as absent from
  the lockfile. Both were present: the scoped override
  `js-yaml@3.15.2 > argparse` did not take effect under npm.
- The [simple-git note](../../../patches/simple-git-parser-residual.md) records
  the patched SHA-256 of both parser entry files. The installed files had the
  published hashes, and three of the five regression tests failed.

The tiny-cbor defect is a correctness bug in encoding: a text string
containing a multi-byte character was written with its UTF-16 length, so a
decoder read too few bytes. No exploit path was
demonstrated here. The patch is installed because the reviewed fix was already
decided and was silently not in effect.

## How it was found

A clean `npm ci` on npm 11.19.1 left `node_modules/js-yaml/bin/js-yaml.js`
and `node_modules/@levischuck/tiny-cbor` without the patched lines. A minimal
project with one `patchedDependencies` entry showed the same with and without
lifecycle scripts. The regression tests that would have caught it looked for
the previous package manager's directory layout and failed for that reason
instead, alongside other pre-existing failures.

## Fix

Each patch now ships as a tarball under `patches/vendor/` that is the
published package with the patch applied. The lockfile installs it by
integrity, so a plain `npm ci` yields the patched code and no install site
needs an extra step. The mechanism, and how to add or remove a patch, is in
[`patches/README.md`](../../../patches/README.md).

- The js-yaml patch now also sets the package's own `argparse` dependency to
  2.0.1, so the tarball is exactly "published plus patch" and does not rely on
  a nested override. `argparse` resolves to 2.0.1 everywhere and `sprintf-js`
  is gone from the lockfile.
- The lockfile change is limited to those entries. It was derived by resolving
  the old and new `package.json` the same way and applying only the difference,
  because a full re-resolve rewrites unrelated entries.
- Four CI jobs install from a sparse checkout of the repository root that left
  `patches/` out. Their lists now include `/patches/vendor`. With an empty npm
  cache, the simulated inventory checkout fails without it and installs with
  it.

No advisory is ignored and no scanner exception is added.

## Proof

- `node scripts/security/patched-dependencies.mjs verify` downloads each
  published package, checks it against the integrity the lockfile recorded
  before this change, applies the patch and compares every file with the
  committed tarball: 36, 42 and 17 files equal. It runs weekly in the security
  workflow.
- `scripts/security/patched-dependencies.test.mjs` (hermetic, in
  `npm run quality:test`): every declared patch is vendored or has no target;
  every lockfile copy installs from the tarball at its integrity; each tarball
  contains its patch; the installed copy equals the tarball; the published
  package is rejected; `sprintf-js` and `argparse@1` are absent; installed
  tiny-cbor encodes a multi-byte string by byte length in both its CommonJS
  and ES module builds.
- `simple-git-upgrade.test.mjs`: all five tests pass, where three failed. The
  installed parser files hash to the patched values in the note.
- `js-yaml-argparse-upgrade.test.mjs`: passes against the installed command
  line on argparse 2.0.1.

## Residual

- A patch does not travel with a package published from this repository. A
  consumer installing a published package resolves its dependencies from the
  registry.
- The adbkit patch has no installed target. A test fails if the package enters
  the lockfile without being vendored.
- `adbkit-transport.test.mjs` and `shell-source-map-upgrade.test.mjs` still
  fail on `main` for a different reason: they resolve modules from locations
  the npm layout does not provide. They are not changed here.
