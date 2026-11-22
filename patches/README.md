# patches/

Fixes to third-party packages that upstream has not released. Each `.patch` file is the reviewed change. Each tarball under `vendor/` is the published package with that patch applied, and is what `npm ci` installs.

## Why tarballs

npm does not apply `patchedDependencies`; that field only names the patch files. Under npm the patched packages were installed exactly as published, with no error and no warning ([audit](../docs/security/audits/2026-11-11-dependency-patches-not-installed.md)).

Applying patches after install would need either a lifecycle script, which this repository does not run, or an extra step at every one of the install sites in CI and the image builds, any of which could be missed silently. Shipping the patched package as a tarball makes a plain `npm ci` correct everywhere: the lockfile pins the tarball by integrity, so an install either gets the patched bytes or fails.

## How it is wired

For each transitive vendored patch, three things point at the tarball:

| Where | What |
|---|---|
| `package.json` `devDependencies` | `"<name>": "file:patches/vendor/<tarball>"` |
| `package.json` `overrides` | `"<name>@<range>": "$<name>"`, which sends every dependent to that root dependency |
| `package-lock.json` | `resolved: file:patches/vendor/<tarball>` and the tarball's `integrity` |

The root dependency is there because npm resolves a relative `file:` override against the package that depends on it, not against the project, and fails. A root dependency resolves correctly, and `$<name>` reuses it. When different versions of one package need separate patches, each can use a root alias; the manifest records the alias and exact override selector. A patched direct workspace dependency can instead pin the tarball with a path relative to its own `package.json`; the manifest records that workspace and the lockfile still pins every installed copy.

[`vendor/manifest.json`](vendor/manifest.json) records, for each patch, the patch file, the tarball and the integrity of the published package it was built from. A patch with no installed target is listed under `notInstalled`; a test fails if the package ever appears in the lockfile.

A CI job with a sparse checkout that runs `npm ci` must include `/patches/vendor`.

## What proves it

- `scripts/security/patched-dependencies.test.mjs`, in `npm run quality:test`, without the network: every declared patch is vendored or has no target; the lockfile installs every copy from the tarball at the tarball's integrity; each tarball contains its patch; the installed copy equals the tarball; and the published, unpatched package is rejected.
- `npm run patches:verify`, weekly in the security workflow, with the network: downloads each published package, refuses it unless it matches the recorded upstream integrity, applies the patch, and compares every file with the committed tarball. This is what shows a tarball is the published package plus the patch and nothing else.
- The behaviour each patch exists for has its own regression: `js-yaml-argparse-upgrade.test.mjs`, `simple-git-upgrade.test.mjs`, and `tiny-cbor-views.test.mjs`.

## Adding or changing a patch

1. Write or edit the `.patch` file against the published package. Paths are relative to the package root (`a/…`, `b/…`).
2. Add the package to `vendor/manifest.json` with the published tarball's integrity. Take it from the lockfile entry before you change anything, or from `npm view <name>@<version> dist.integrity`.
3. Add the root dependency and the override described above, and name the patch in `patchedDependencies`.
4. Build the tarball and pin the lockfile:

   ```bash
   npm run patches:build
   ```

   This writes the tarball and sets `resolved` and `integrity` on every lockfile copy of that package version. The first time a package is vendored, also add its root or workspace dependency line to the matching lockfile entry. If the patch changes dependency metadata, update the package's lockfile dependency entry as well.
5. Install and run the checks:

   ```bash
   npm ci
   npm run patches:verify
   node --test scripts/security/patched-dependencies.test.mjs
   ```

6. Add a regression test for the behaviour the patch changes.

Do not edit a tarball by hand, and do not regenerate the whole lockfile to pick up the change: a full re-resolve rewrites unrelated entries.

## Removing a patch

When upstream ships the fix: bump the dependency, delete the `.patch` file, the tarball and the manifest entry; replace the workspace or root dependency and remove any override, then remove it from `patchedDependencies`.

## Current patches

| Package | Why | Detail |
|---|---|---|
| `js-yaml@3.15.2` | Runs its command line on argparse 2, which removes `sprintf-js` (GHSA-hp3w-g68c-fv3c) from the tree | [audit](../docs/security/audits/2026-10-06-password-parity-cli-dependencies.md) |
| `@simple-git/argv-parser@2.0.1` | Rejects abbreviated Git pack-executable options that the published guards miss | [note](simple-git-parser-residual.md) |
| `@levischuck/tiny-cbor@0.2.11` | Encodes text by its UTF-8 byte length, respects input view offsets and rejects truncated byte and text strings | [audit](../docs/security/audits/2026-11-11-dependency-patches-not-installed.md) |
| `@levischuck/tiny-cbor@0.3.6` | Rejects truncated byte and text strings and accepts `Uint8Array` subclasses including Node `Buffer` | `scripts/security/tiny-cbor-views.test.mjs` |
| `picomatch@2.3.2` and `4.0.7` | Bounds repeated-star extglob matching for GHSA-fc5q-39xc-vjpf, including malformed and composed forms | `scripts/security/picomatch-backport.test.mjs` |
| `typed-rest-client@2.3.1` | Allows the existing security-fixed `qs` release | `scripts/lib/dependency-compatibility.test.mjs` |
| `@esbuild-kit/core-utils@3.3.2` | Allows the security-fixed esbuild used by its loader | `scripts/security/npm-workspaces.test.mjs` |
| `nunjucks@3.2.4` | Supports chokidar 5 and starts its resolver watcher with an empty path list | `scripts/security/npm-workspaces.test.mjs` |
| `@aws-sdk/xml-builder@3.972.42` | Preserves XML Unicode and entities and bounds custom entity expansion | `scripts/security/aws-xml-compat.test.mjs` and `.deepsec/aws-xml-compat.test.mjs` |
| `kdbxweb@2.1.1` | Preserves tabs and carriage returns in XML text and CDATA and uses the reviewed fixed XML parser | `scripts/security/kdbxweb-compat.test.mjs` |
| `minimatch@11.0.9` | Keeps a bounded `braceExpandMax` default of 100,000 on the published release outside GHSA-g3hv-75wg-m249 | [compatibility note](#glob-and-minimatch-compatibility) |
| `@joshwooding/vite-plugin-react-docgen-typescript@0.7.0`, `react-docgen-typescript@2.4.0` | Use the TypeScript 6 compiler API alongside the workspace's TypeScript 7 | `scripts/security/removed-dependencies.test.mjs` |
| `node-turn@0.0.6` | Declares the reviewed security-fixed `js-yaml` and `log4js` releases used by the live TURN verifier | `scripts/security/dependency-override-upgrade.test.mjs` |
| `@noble/post-quantum@0.5.4` | Declares the compatible, reviewed Noble 2.4 primitives already used by the workspace | `scripts/security/dependency-override-upgrade.test.mjs` |
| `@devicefarmer/adbkit@3.3.8` | Loads its TCP bridge and key parser lazily. Not installed: nothing in the lockfile depends on it | `vendor/manifest.json` |

The picomatch backport preserves the generated expressions and ordinary match
results. In Node, expressions with ambiguous nested repetition, repeated
alternatives, multiple extglob repetitions, or direct quantified regex input
execute in a reusable worker and throw if the match exceeds its deadline.
Browser runtimes reject those expressions rather than returning a
false match, which could bypass an exclusion. Public `parse`, `compileRe`,
`makeRe`, and `toRegex` calls reject risky expressions before exposing either
raw source or a `RegExp`; bounded matchers also redact their internal state and
expression from detailed results. This prevents native `RegExp.prototype`
methods from bypassing the worker boundary. The package retains its published
version, while the recorded tarball integrity and regression tests identify
the patched copy.

A patch does not travel with a package published from this repository. A consumer who installs a published package resolves its dependencies from the registry.

## Glob and minimatch compatibility

Every `glob` copy is the published `glob` 14.0.6, outside GHSA-3g3m-2fjr-6pw4
(`>=9.0.0 <=14.0.1`). The `glob@^10.0.0`, `glob@^11.0.1`, `glob@^13.0.1` and
`glob@^13.0.6` overrides, and the direct glob pins for Promptfoo, docgen and
the filesystem server, select it. Archiver (`archiver-utils`, through
testcontainers) calls `glob.sync` and Workbox (`workbox-build`, through
`vite-plugin-pwa`) calls `globSync` with `cwd`, `follow` and `ignore`; glob 14
keeps those exports and options in both its CommonJS and ESM builds.

Glob 14 depends on `minimatch` 11. Every `minimatch` 10 or 11 range, and
glob 14 itself, resolves to the vendored `minimatch` 11.0.9, outside
GHSA-g3hv-75wg-m249 (`>=7.0.0 <=11.0.0`). Upstream 11.x throws a `RangeError`
instead of building an unbounded glob-part set. The patch only gives brace
expansion a bounded 100,000-alternative default when `braceExpandMax` is unset
or invalid, so an archive or Workbox precache pattern still matches past the
10,000th alternative instead of silently omitting a file.

`minimatch` 5.1.9 uses `brace-expansion` 2.1.8 for `filelist` and
`readdir-glob`, which keep their documented `noglobstar` and parent-segment
behavior. Both are published versions within those consumers' declared ranges
and outside the known affected ranges in the local advisory database.

No Glob or Minimatch advisory finding remains, so the audit gate attests no
exception: any finding fails it.

`glob-override-upgrade.test.mjs` fails if any lockfile copy of either package
re-enters its advisory range. `removed-dependencies.test.mjs` exercises promise
and stream cancellation through the installed CommonJS and ESM packages, and
its consumer tests cover the archive, Workbox, Promptfoo, filesystem search,
Stryker and docgen paths, including the bounded glob-part and brace expansion
of the matcher that Archiver and Workbox load. `patches:verify` compares the
vendored tarball against the integrity-pinned published archive plus its patch.

## SQLx SQLite compatibility backport

`patches/vendor/sqlx-sqlite-0.9.0/` is the published `sqlx-sqlite` 0.9.0
crate (SHA-256 `488e99c397a62007e4229aec669a179816339afc6d2620ca6fa420dbee2e982c`).
Its only code-distribution change is the dependency constraint for
`libsqlite3-sys`: require 0.39.1 and accept versions below 0.40. This follows
upstream's [0.39 compatibility change](https://github.com/launchbadge/sqlx/commit/10462fa4414c6c7f1ed1d39bb31678e3b726878c)
and keeps the bundled SQLite at a version fixed for RUSTSEC-2026-0459. The
crate's own ignored `Cargo.lock` is omitted so it cannot be mistaken for the
workspace lockfile. The MIT and Apache licenses and all source bytes are kept.

`python3 scripts/security/verify-vendored-sqlx.py` checks the upstream archive's
digest, the complete source inventory, and every file against the archive with
only the reviewed manifest substitution. The structural quality gate runs this
verification before excluding the immutable third-party source from the
repository's source-size ratchet; CI runs it alongside the other patch checks.

## Keepass timestamp parsing backport

`patches/vendor/keepass-0.17.0/` is the published `keepass` 0.17.0 crate
(SHA-256 `8025344cf174f72cccbac2a99640a8d1e82cf46922d57e06a45a32e49edfed16`).
The only source change requires KDBX4 binary timestamps to decode to exactly
eight bytes and uses checked date arithmetic. This prevents malformed vault
timestamps from panicking the importer or overflowing the representable date
range. The vendored `Cargo.lock` is omitted, as with sqlx-sqlite, so it
cannot be mistaken for a workspace lockfile. The original archive, licenses,
and every other unchanged source byte remain in the repository.

`python3 scripts/security/verify-vendored-keepass.py` checks the published
archive digest, full file inventory, exact patched-file digest, both Cargo path
bindings, and both lockfile identities. The structural quality gate verifies
those conditions before excluding immutable upstream source from its ratchet.
`check-keepass-scanner-coverage.py` additionally proves that the offline OSV
gate continues to inspect the path dependency in both Cargo lockfiles.

## KDBX XML compatibility backport

The vendored `kdbxweb` patch preserves legal tab characters when reading XML
and carriage returns in text and CDATA written to XML, in its source,
Node/browser UMD and minified distribution. It changes the SDK's XML parser
requirement to the exact reviewed `0.8.15` version. The app-core workspace
installs that tarball directly; verification checks the installed copies and
compares them with the published SDK plus this patch.

## AWS XML compatibility and security backport

The root and DeepSec workspaces share the patched `@aws-sdk/xml-builder`
3.972.42 tarball. It preserves supplementary Unicode and known and unknown
named entity references, validates document structure, and bounds nesting
and custom entity expansion. XML documents with custom declarations use the
SDK's former parser with bounded expansion; external entities are rejected.
The patch includes the MIT license and attribution for entity tables derived
from `@nodable/entities` 2.1.0. Root and DeepSec regressions exercise the
actual AWS SDK consumers, and patch verification compares the vendor tarball
with the published package plus this patch.
