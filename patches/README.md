# patches/

Fixes to third-party packages that upstream has not released. Each `.patch` file is the reviewed change. Each tarball under `vendor/` is the published package with that patch applied, and is what `npm ci` installs.

## Why tarballs

npm does not apply `patchedDependencies`; that field only names the patch files. Under npm the patched packages were installed exactly as published, with no error and no warning ([audit](../docs/security/audits/2026-11-11-dependency-patches-not-installed.md)).

Applying patches after install would need either a lifecycle script, which this repository does not run, or an extra step at every one of the install sites in CI and the image builds, any of which could be missed silently. Shipping the patched package as a tarball makes a plain `npm ci` correct everywhere: the lockfile pins the tarball by integrity, so an install either gets the patched bytes or fails.

## How it is wired

For each vendored patch, three things point at the tarball:

| Where | What |
|---|---|
| `package.json` `devDependencies` | `"<name>": "file:patches/vendor/<tarball>"` |
| `package.json` `overrides` | `"<name>@<range>": "$<name>"`, which sends every dependent to that root dependency |
| `package-lock.json` | `resolved: file:patches/vendor/<tarball>` and the tarball's `integrity` |

The root dependency is there because npm resolves a relative `file:` override against the package that depends on it, not against the project, and fails. A root dependency resolves correctly, and `$<name>` reuses it.

[`vendor/manifest.json`](vendor/manifest.json) records, for each patch, the patch file, the tarball and the integrity of the published package it was built from. A patch with no installed target is listed under `notInstalled`; a test fails if the package ever appears in the lockfile.

A CI job with a sparse checkout that runs `npm ci` must include `/patches/vendor`.

## What proves it

- `scripts/security/patched-dependencies.test.mjs`, in `npm run quality:test`, without the network: every declared patch is vendored or has no target; the lockfile installs every copy from the tarball at the tarball's integrity; each tarball contains its patch; the installed copy equals the tarball; and the published, unpatched package is rejected.
- `npm run patches:verify`, weekly in the security workflow, with the network: downloads each published package, refuses it unless it matches the recorded upstream integrity, applies the patch, and compares every file with the committed tarball. This is what shows a tarball is the published package plus the patch and nothing else.
- The behaviour each patch exists for has its own regression: `js-yaml-argparse-upgrade.test.mjs`, `simple-git-upgrade.test.mjs`, and the tiny-cbor case in `patched-dependencies.test.mjs`.

## Adding or changing a patch

1. Write or edit the `.patch` file against the published package. Paths are relative to the package root (`a/…`, `b/…`).
2. Add the package to `vendor/manifest.json` with the published tarball's integrity. Take it from the lockfile entry before you change anything, or from `npm view <name>@<version> dist.integrity`.
3. Add the root dependency and the override described above, and name the patch in `patchedDependencies`.
4. Build the tarball and pin the lockfile:

   ```bash
   npm run patches:build
   ```

   This writes the tarball and sets `resolved` and `integrity` on every lockfile copy of that package version. The first time a package is vendored, also add the root dependency line to the lockfile's root `devDependencies`, as `package.json` has it.
5. Install and run the checks:

   ```bash
   npm ci
   npm run patches:verify
   node --test scripts/security/patched-dependencies.test.mjs
   ```

6. Add a regression test for the behaviour the patch changes.

Do not edit a tarball by hand, and do not regenerate the whole lockfile to pick up the change: a full re-resolve rewrites unrelated entries.

## Removing a patch

When upstream ships the fix: bump the dependency, delete the `.patch` file, the tarball, the manifest entry, the root dependency and the override, and remove it from `patchedDependencies`.

## Current patches

| Package | Why | Detail |
|---|---|---|
| `js-yaml@3.15.2` | Runs its command line on argparse 2, which removes `sprintf-js` (GHSA-hp3w-g68c-fv3c) from the tree | [audit](../docs/security/audits/2026-10-06-password-parity-cli-dependencies.md) |
| `@simple-git/argv-parser@2.0.1` | Rejects abbreviated Git pack-executable options that the published guards miss | [note](simple-git-parser-residual.md) |
| `@levischuck/tiny-cbor@0.2.11` | Encodes a text string by its byte length, not its UTF-16 length | [audit](../docs/security/audits/2026-11-11-dependency-patches-not-installed.md) |
| `@devicefarmer/adbkit@3.3.8` | Loads its TCP bridge and key parser lazily. Not installed: nothing in the lockfile depends on it | `vendor/manifest.json` |

A patch does not travel with a package published from this repository. A consumer who installs a published package resolves its dependencies from the registry.
