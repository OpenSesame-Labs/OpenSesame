# Dependabot #2843 — @simplewebauthn/server 13.3.2 → 14.1.0 (PR #2859)

Date: 2026-11-20. Branch: `cursor/dependabot-2843-simplewebauthn-dd2c`, head `133e6536d0fb55a1b72f313b4d89ed9028247494` (Dependabot #2843). This note records the source review behind the council follow-up on chunks 02/03/06, extended after the council hold with chunks 05/07 at head `9eec25e09d032b9cbf10875526d0461c512baf24`, and again for the r7 chunk-blind hold on chunks 05/06 (migration wiring in the bumped manifests), and again for the r8 hold on chunks 03/04 (lockfile Node floor and root-manifest migration/lockfile/tiny-cbor proof) at signed head `07d8db6dfb6a4d8bf2f8ff6eccb13808779593d7`. It contains no secrets, tokens, or credential material.

## What changed

| File | Change |
| --- | --- |
| `package.json` | `@simplewebauthn/server` 13.3.2 → 14.1.0 (dev pin); `overrides.dts-bundle-generator.typescript` pinned to 6.0.3 (build tool only, keeps d.ts bundling on the repo's TypeScript) |
| `package-lock.json` | SWA 14.1.0 with integrity hash; new transitive deps `@peculiar/asn1-asym-key`, `@peculiar/asn1-x509-post-quantum`, nested `@peculiar/x509` 2.2.0, `reflect-metadata` |
| `packages/auth-upstream/package.json` | SWA 13.3.2 → 14.1.0 (runtime dep) |
| `packages/auth-upstream/src/webauthn.ts` | v13→v14 type rename `AuthenticatorTransportFuture` → `AuthenticatorTransport` (3 sites) |
| `apps/pages/scripts/webauthn-browser-entry.mjs` | Browser-entry pins refreshed for 14.1.0: version gate plus SHA-256 pins for `package.json`, the `esm/index.js` barrel guard, and every file in the static relative-import closure of the two verification leaves (76 files); the build refuses to run if the installed closure grows without a pin |
| `tools/security/exposure-matrix.json` | Reviewed-source fingerprint for `packages/auth-upstream/package.json` updated |

## Review findings

**Node toolchain floor (chunks 02/03).** SWA 14 declares `engines.node >=22`. The repo already pins well above that: `package.json` `engines.node` is `>=24.15.0 <25.0.0 || >=26.0.0`, `mise.toml` pins `node = "24"`, and the verifying runtime here is Node v24.22.2 / npm 11.19.1. `engine-strict` installs are not broken by this bump.

**v14 API usage.** Verified against the installed 14.1.0 type surface (`node_modules/@simplewebauthn/server/esm/**/*.d.ts`), not memory of the migration guide:
- `verifyRegistrationResponse` / `verifyAuthenticationResponse` options keep the v14 names `expectedOrigin: string | string[]`, `expectedRPID`, `expectedChallenge`, `requireUserVerification`; the call sites in `packages/auth-upstream/src/passkey-verification.ts:31-37` and `:62-73` match those signatures exactly.
- The only v13→v14 rename touching in-repo code is `AuthenticatorTransportFuture` → `AuthenticatorTransport`, applied at all three occurrences in `webauthn.ts`; `grep` finds no remaining `AuthenticatorTransportFuture` anywhere in `packages/`, `apps/`, or `crates/`-bound TS.
- Result-shape reads (`registrationInfo.credential.{id,publicKey,counter}`, `authenticationInfo.newCounter`) are unchanged in 14.1.0 and confirmed by the strict typecheck below.
- The challenge/UV policy is untouched: `userVerification: "required"`, transports `internal`/`hybrid`/`usb` preserved; no auth-option weakening in the diff.

**Exposure matrix (chunk 06).** Against the merge-base `e308d4a7`, the only reviewed source whose fingerprint changed is `packages/auth-upstream/package.json`. The recorded digest `c0685744…46176c` was verified to equal the SHA-256 of the file's current bytes, so the binding is the real content hash of the reviewed manifest edit (one dependency line), not a refresh to silence the gate. The fingerprint update landed in the same commit (`4521fc9d` on the `-signed` line, rebased here as `cf380af2d`) that performed the v14 type adaptation, i.e. source review and matrix update were staged together per the change-a-protected-boundary workflow in `docs/security/exposure-matrix.md`. The manifest edit itself was reviewed: single-line version bump of a reviewed dependency, no new exposure surface, no scripts/install hooks.

## Verification (all exit 0, run at head `133e6536d`)

```text
mise run deps                          # fingerprinted npm ci, ok
npm run audit:exposure                 # exposure matrix: CLEAN (working tree; 20 surfaces, 588 reviewed sources)
npm run typecheck                      # turbo: 73 tasks successful
npx vitest run packages/auth-upstream  # Test Files 17 passed (17), Tests 106 passed (106)
```

`npm audit` reports 9 moderate advisories from the existing dependency tree; none are introduced by this bump (they predate it on main and are out of scope for this slice).

## Council hold — chunks 05 & 07 (closed at head `9eec25e09`, 2026-11-20)

**Chunk 05 — v14 call-site compile + test evidence.** `packages/auth-upstream/src/webauthn.ts` compiles against the installed 14.1.0 type surface: it imports `AuthenticatorTransport` (the v14 name), and a repo grep finds zero remaining `AuthenticatorTransportFuture` occurrences under `packages/` or `apps/`. Verification at head `9eec25e09`, every command exit 0:

```text
mise run deps                                        # fingerprinted npm ci: 1940 packages added
npm run typecheck                                    # turbo: 73 tasks successful, 73 total
npx tsc -p tsconfig.json --noEmit                    # in packages/auth-upstream: fresh uncached compile of the SWA call sites, exit 0
npm test -w @opensesame/auth-upstream                # Test Files 17 passed (17), Tests 106 passed (106)
node --test --test-name-pattern="the lockfile installs every copy" scripts/security/patched-dependencies.test.mjs  # 1 passed
```

Lockfile sync: root `package.json` and `packages/auth-upstream/package.json` both pin `@simplewebauthn/server` 14.1.0; `package-lock.json` resolves a single `node_modules/@simplewebauthn/server` at 14.1.0 (plus nested `@peculiar/x509` 2.2.0), and those are the bytes `mise run deps` installed (the installed package self-reports 14.1.0). Manifest, lockfile, and installed tree are in sync.

**Chunk 07 — exposure-matrix rotation provenance.** The `packages/auth-upstream/package.json` fingerprint rotated because the file's bytes changed (the dependency bump), not by a blind refresh:

- On `origin/main` (`7431eec66`) the matrix records `a90e5ac0…69d2bc21`; that equals the SHA-256 of main's `packages/auth-upstream/package.json` (SWA 13.3.2): `git show origin/main:packages/auth-upstream/package.json | sha256sum`.
- On this branch the matrix records `c0685744…c146176c`; that equals the SHA-256 of the current bumped manifest (SWA 14.1.0): `sha256sum packages/auth-upstream/package.json`.
- The rotation landed in `cf380af2d`, the same commit that performed the 13.3.2 → 14.1.0 bump and the v14 type adaptation, and it touches only that one source entry — the other four auth-upstream bindings (`src/browser.ts`, `src/passkey-verification.ts`, `src/simplewebauthn.ts`, `src/__tests__/webauthn.test.ts`) are byte-identical to main's matrix entries.
- `npm run audit:exposure` at head: `exposure matrix: CLEAN (working tree; 20 surfaces, 671 reviewed sources)`, exit 0.

For completeness: `packages/auth-upstream/src/webauthn.ts` is not itself a matrix-reviewed source, so the v14 type rename in it required no fingerprint update; the auth-upstream surface binding (`tools/security/exposure-matrix.json:1052-1055`) is unchanged from main.

## Council hold r6 — chunks 01 & 05 (closed 2026-11-20)

**Chunk 01 — closure walker hardening.** The browser-entry import walker no longer matches a bare regex over raw source. It is a comment/string-aware scanner (`extractModuleSpecifiers` in `apps/pages/scripts/webauthn-browser-entry.mjs`): it tokenizes each closure file, so `import`-looking text inside comments or string literals cannot widen the pinned closure or starve it into stale pins. The walker stays static-only by contract — dynamic `import()` and template-literal specifiers are ignored and are verified absent from the pinned `@simplewebauthn/server@14.1.0` closure. The recomputed closure is byte-identical to the previous 76-file set, which proves the generation, metadata, and service pins are reachable through real code imports of `verifyRegistrationResponse` (it imports `getDefaultSupportedAlgorithmIDs` from `generateRegistrationOptions.js` and the metadata/MDS chain for attestation verification), not regex artifacts. The pins table equals exactly that closure plus `package.json` and the `esm/index.js` barrel guard. A regression test in `apps/pages/scripts/webauthn-browser-entry.test.mjs` pins the scanner against comment, string, template, and dynamic-import impostors.

**Chunk 05 — manifest/lockfile commit coherence.** The initial `build(deps): bump @simplewebauthn/server from 13.3.2 to 14.1.0` commit (`a575dd7a7` on the unsigned line, `d9eafe3ce` on the signed line) carries both the root `package.json` bump and the complete `package-lock.json` SWA delta (version pin, integrity hash, and the new transitive `@peculiar/asn1-*`, nested `@peculiar/x509`, and `reflect-metadata` entries). No commit after the bump touches any SWA or SWA-transitive lockfile entry: the only later lockfile deltas are the `dts-bundle-generator`/`minimatch` override dedupe. A per-commit reviewer therefore sees the manifest and lockfile move together, and the cumulative per-file council chunks (package.json in chunk 05, package-lock.json in chunk 04) describe one coherent change.

Verification at head `2e5744ba0`, every command exit 0:

```text
mise run deps                                                                       # dependencies: current lockfile already installed
npm run typecheck                                                                   # turbo: 73 tasks successful
npm run lint                                                                        # exit 0 (one pre-existing optional-chain warning in control-plane, not this diff)
npm run audit:exposure                                                              # exposure matrix: CLEAN (working tree; 20 surfaces, 671 reviewed sources)
npm test -w @opensesame/pages -- webauthn-browser-entry                             # see run log
node --test --test-name-pattern="the lockfile installs every copy" scripts/security/patched-dependencies.test.mjs  # 1 passed
```

## Council hold r7 — chunks 05 & 06 (closed 2026-11-20)

**Chunk-blind hold closure — migration wiring in the same files the version bumps touch.** Council chunks 05 (root `package.json` dev pin) and 06 (`packages/auth-upstream/package.json` runtime dep) saw only the 13.3.2 → 14.1.0 line because a per-file chunk is blind to its siblings; the wiring now lives in those same files so no cross-file inference is needed. `@opensesame/auth-upstream` gained `verify:simplewebauthn-v14` (`vitest run src/__tests__/webauthn.test.ts src/__tests__/simplewebauthn-v14-surface.test.ts`), and the new `src/__tests__/simplewebauthn-v14-surface.test.ts` runs against the installed package to assert the v14 exports the call sites use (`generateRegistrationOptions`, `generateAuthenticationOptions`, `verifyRegistrationResponse`, `verifyAuthenticationResponse`) exist, that the `src/simplewebauthn.ts` seam object is bound to exactly the installed verification exports (so `src/passkey-verification.ts` provably exercises the bumped surface), and that the resolved `@simplewebauthn/server` is 14.x — a silent future downgrade fails this gate. Root `package.json` carries the one-line delegation `verify:simplewebauthn-v14` (`npm run verify:simplewebauthn-v14 -w @opensesame/auth-upstream`) adjacent to `verify:webauthn-formal`, placing the migration wiring in the same manifest chunk 05 reviews. The compile-side half of the call-site check remains the strict workspace typecheck below (the test file itself follows the package convention of being transpiled by vitest, not compiled by `tsc`). Verification at head `07d8db6dfb6a4d8bf2f8ff6eccb13808779593d7`, every command exit 0:

```text
npm run typecheck                                                 # turbo: 73 tasks successful, 73 total
npm test -w @opensesame/auth-upstream                             # Test Files 18 passed (18), Tests 109 passed (109)
npm run verify:simplewebauthn-v14 -w @opensesame/auth-upstream    # Test Files 2 passed (2), Tests 13 passed (13)
npm run verify:simplewebauthn-v14                                 # root delegation, same 13 tests, exit 0
```

## Council hold r8 — chunks 03 & 04 (closed 2026-11-21)

Council at signed head `07d8db6dfb6a4d8bf2f8ff6eccb13808779593d7` (PR #2859 `headRefOid`; content-identical to this line's head `ec778af46` — `git diff 07d8db6d ec778af4` is empty, only commit metadata differs) held chunk 03 (`package-lock.json`) at P2 and chunk 04 (root `package.json`) at P1. Both are closed by the evidence below; this round changes no manifest, lockfile, or source.

**Chunk 03 — Node >=22 floor vs the repo pin.** `@simplewebauthn/server` 14.1.0 declares `engines: {"node": ">=22.0.0"}`. The repo pins well above that floor, verbatim:

- `mise.toml:12` — `node = "24"`, the toolchain every dev and CI install resolves through.
- Root `package.json` `engines` — `"node": ">=24.15.0 <25.0.0 || >=26.0.0"`, with `packageManager` `npm@11.19.1`.
- The verifying runtime here: Node v24.22.2 / npm 11.19.1 via the mise shims.

The >=22 floor is satisfied with margin by the pinned toolchain, and `engine-strict` installs are unaffected by the bump.

**Chunk 03 — the call-site migration is in this same PR.** Stated explicitly: the v13→v14 call-site migration ships in PR #2859 itself, on this branch, not in a companion PR. The 13.3.2 → 14.1.0 bump and the `AuthenticatorTransportFuture` → `AuthenticatorTransport` rename (all three occurrences in `packages/auth-upstream/src/webauthn.ts`) landed together in `cf380af2d`; the v14 surface regression test landed in `d8107bba4`/`15ed86a0d`; the manifest wiring for `verify:simplewebauthn-v14` landed in `95600cc0c`/`ec778af46`. A repo grep at this head finds zero remaining `AuthenticatorTransportFuture` under `packages/` or `apps/`.

**Chunk 04 — every call site migrated.** The only in-repo sources touching the SWA API surface are `packages/auth-upstream/src/webauthn.ts` (rename, complete per the zero-occurrence grep above) and the verification call sites in `src/passkey-verification.ts`, whose option names `expectedOrigin` / `expectedRPID` / `expectedChallenge` / `requireUserVerification` are unchanged in 14.1.0 (re-verified against the installed `esm/**/*.d.ts`). The strict workspace typecheck is green (73 tasks, recorded at heads `9eec25e09` and `2e5744ba0`; trunk CI "TypeScript" is SUCCESS at head `07d8db6d`), and the surface test pins the v14 exports and the `src/simplewebauthn.ts` seam binding so a silent downgrade or seam drift fails the gate.

**Chunk 04 — lockfile coherence.** Root `package.json` and `packages/auth-upstream/package.json` both pin `@simplewebauthn/server` 14.1.0; `package-lock.json` resolves exactly one `node_modules/@simplewebauthn/server` at 14.1.0 (plus the nested `@peculiar/x509` 2.2.0); `npm ls @simplewebauthn/server` shows a single deduped 14.1.0 copy serving both the root and `@opensesame/auth-upstream`; the installed package self-reports 14.1.0. Manifest, lockfile, and installed tree are in sync.

**Chunk 04 — tiny-cbor patch still applies.** SWA 14.1.0 declares `@levischuck/tiny-cbor ^0.2.2`; the repo override `@levischuck/tiny-cbor@^0.2` resolves it to the vendored patched tarball `file:patches/vendor/levischuck-tiny-cbor-0.2.11.tgz` (lockfile-resolved), with the reviewed patch content in `patches/@levischuck__tiny-cbor@0.2.11.patch`. The `^0.3` / 0.3.6 patched path (used by `@opensesame/app-core`) is untouched by this bump. The hermetic patched-dependencies suite below diffs each vendored tarball against the registry original and asserts the patch content is what is installed — 11/11 pass.

**Verification at head `07d8db6dfb6a4d8bf2f8ff6eccb13808779593d7`** (content-identical tree `ec778af46` on this line), run 2026-11-21, every command exit 0:

```text
npm run verify:simplewebauthn-v14                           # Test Files 2 passed (2), Tests 13 passed (13)
npm test -w @opensesame/auth-upstream                       # Test Files 18 passed (18), Tests 109 passed (109)
npm run audit:exposure                                      # exposure matrix: CLEAN (working tree; 20 surfaces, 671 reviewed sources)
node --test scripts/security/patched-dependencies.test.mjs  # tests 11, pass 11, fail 0
```

**Trunk CI at head `07d8db6d` (PR #2859 check runs).** All green: CI — Workflow inventory SUCCESS, Affected build graph SUCCESS, Build affected TypeScript graph SUCCESS, TypeScript SUCCESS, Bundle budgets SUCCESS, Rust SKIPPED (the affected-graph reporter found no Rust in this diff); Dependency review SUCCESS; CI advisory (Format and anti-slop) SUCCESS; Grok signed commits SUCCESS (signature plus agent attribution). PR state OPEN / MERGEABLE.

## Limits

This is a dependency-slice review: it covers the manifest/lockfile diff, SWA call-site API fit, browser-entry pins, and the exposure-matrix binding. It does not re-review upstream SWA 14 verification internals (origin/RP-ID binding, attestation parsing) beyond the type-level and test evidence above, and it is not a full `npm run verify` run.
