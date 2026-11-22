# Dependabot #669 — Glob and Minimatch move to published fixed releases

Date: 2026-11-22. Base: `origin/main` `6e0aa5d64`. Verifying runtime: Node
v24.22.2 / npm 11.19.1. This document contains no secrets, tokens, or
credential material.

## Problem

Alert #669 (minimatch GHSA-g3hv-75wg-m249, `>=7.0.0 <=11.0.0`) stayed open
after #2863 because the lockfile still installed `minimatch@9.0.9`, a locally
patched backport, under `archiver-utils`, `workbox-build` and the
`glob10-patched` alias. Dependabot matches by version, so a patched 9.0.9 is
still reported. The same consumers installed patched `glob@10.5.0` and
`glob@11.1.0`, which `npm audit` reports under GHSA-3g3m-2fjr-6pw4
(`>=9.0.0 <=14.0.1`). Neither package line has an upstream fixed release below
glob 14.0.2 and minimatch 11.0.1.

## Change

- `glob@^10.0.0` and `glob@^11.0.1` now resolve to the published glob 14.0.6,
  already used by Promptfoo, docgen and the filesystem server. Its minimatch
  edge is the vendored minimatch 11.0.9, outside GHSA-g3hv-75wg-m249.
- Removed: the glob 10.5.0, glob 11.1.0 and minimatch 9.0.9 patches, tarballs,
  root aliases, overrides and manifest entries; the unreferenced minimatch
  10.2.6 patch and tarball left by #2863.
- `assert-no-advisories.mjs` attests no exception; any finding fails.
- `dependency-review.yml` returns to its graph-only form: no checkout, no
  backport attestation step and no `allow-ghsas` exemption.

## Consumer compatibility

Archiver calls `glob.sync(pattern, options)` (`archiver-utils/file.js`);
Workbox calls `globSync(pattern, { cwd, follow, ignore })`
(`workbox-build/build/lib/get-file-details.js`). Glob 14 keeps both exports in
its CommonJS and ESM builds. Glob 14 is the line built for minimatch 11 (it
matches with minimatch 11's `Matcher` objects), so the consumers move to both
together. Minimatch 11 throws a `RangeError` on glob-part amplification,
and the vendored patch keeps a bounded 100,000-alternative brace default, so a
pattern past the 10,000th alternative still matches.

## Executed checks

| Check | Result |
| --- | --- |
| `npm audit` before (base lockfile) | 9 moderate: glob GHSA-3g3m-2fjr-6pw4, minimatch GHSA-g3hv-75wg-m249 and their dependents |
| `npm audit` after | 0 vulnerabilities |
| `npm ci --ignore-scripts` from the new lockfile | passed |
| `glob-override-upgrade`, `removed-dependencies`, `dependency-override-upgrade`, `assert-no-advisories`, `npm-workspaces`, `patched-dependencies`, `osv-scanner-gate`, `osv-scanner-integrity` tests | passed |
| Archiver `file.expand` brace and negation patterns; `archiver("tar")` `directory` and `glob` | passed |
| Workbox `getManifest` and `generateSW` with the Pages `globPatterns` | 7 entries, `node_modules` ignored, no warnings |
| `npm run audit:exposure`, `npm run lint` | CLEAN |

`npm run build -w @opensesame/pages` could not run here: its Tailscale native
asset step downloads Go source, and this environment's proxy refused it (HTTP
403). The Workbox check above exercises the same `workbox-build` calls.
