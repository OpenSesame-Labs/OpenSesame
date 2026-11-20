# Dependabot #2843 — @simplewebauthn/server 13.3.2 → 14.1.0 (PR #2859)

Date: 2026-11-20. Branch: `cursor/dependabot-2843-simplewebauthn-dd2c`, head `133e6536d0fb55a1b72f313b4d89ed9028247494` (Dependabot #2843). This note records the source review behind the council follow-up on chunks 02/03/06. It contains no secrets, tokens, or credential material.

## What changed

| File | Change |
| --- | --- |
| `package.json` | `@simplewebauthn/server` 13.3.2 → 14.1.0 (dev pin); `overrides.dts-bundle-generator.typescript` pinned to 6.0.3 (build tool only, keeps d.ts bundling on the repo's TypeScript) |
| `package-lock.json` | SWA 14.1.0 with integrity hash; new transitive deps `@peculiar/asn1-asym-key`, `@peculiar/asn1-x509-post-quantum`, nested `@peculiar/x509` 2.2.0, `reflect-metadata` |
| `packages/auth-upstream/package.json` | SWA 13.3.2 → 14.1.0 (runtime dep) |
| `packages/auth-upstream/src/webauthn.ts` | v13→v14 type rename `AuthenticatorTransportFuture` → `AuthenticatorTransport` (3 sites) |
| `apps/pages/scripts/webauthn-browser-entry.mjs` | Browser-entry pins refreshed for 14.1.0: version gate plus new SHA-256 pins for `package.json`, `esm/index.js`, `verifyAuthenticationResponse.js`, `verifyRegistrationResponse.js` |
| `tools/security/exposure-matrix.json` | Reviewed-source fingerprint for `packages/auth-upstream/package.json` updated |

## Review findings

**Node toolchain floor (chunks 02/03).** SWA 14 declares `engines.node >=22`. The repo already pins well above that: `package.json` `engines.node` is `>=24.15.0 <25.0.0 || >=26.0.0`, `mise.toml` pins `node = "24"`, and the verifying runtime here is Node v24.22.2 / npm 11.19.1. `engine-strict` installs are not broken by this bump.

**v14 API usage.** Verified against the installed 14.1.0 type surface (`node_modules/@simplewebauthn/server/esm/**/*.d.ts`), not memory of the migration guide:
- `verifyRegistrationResponse` / `verifyAuthenticationResponse` options keep the v14 names `expectedOrigin: string | string[]`, `expectedRPID`, `expectedChallenge`, `requireUserVerification`; the call sites in `packages/auth-upstream/src/passkey-verification.ts:31-37` and `:62-73` match those signatures exactly.
- The only v13→v14 rename touching in-repo code is `AuthenticatorTransportFuture` → `AuthenticatorTransport`, applied at all three occurrences in `webauthn.ts`; `grep` finds no remaining `AuthenticatorTransportFuture` anywhere in `packages/`, `apps/`, or `crates/`-bound TS.
- Result-shape reads (`registrationInfo.credential.{id,publicKey,counter}`, `authenticationInfo.newCounter`) are unchanged in 14.1.0 and confirmed by the strict typecheck below.
- The challenge/UV policy is untouched: `userVerification: "required"`, transports `internal`/`hybrid`/`usb` preserved; no auth-option weakening in the diff.

**Exposure matrix (chunk 06).** Against the merge-base `e308d4a7`, the only reviewed source whose fingerprint changed is `packages/auth-upstream/package.json`. The recorded digest `c0685744…46176c` was verified to equal the SHA-256 of the file's current bytes, so the binding is the real content hash of the reviewed manifest edit (one dependency line), not a refresh to silence the gate. The fingerprint update landed in the same commit (`4521fc9d`) that performed the v14 type adaptation, i.e. source review and matrix update were staged together per the change-a-protected-boundary workflow in `docs/security/exposure-matrix.md`. The manifest edit itself was reviewed: single-line version bump of a reviewed dependency, no new exposure surface, no scripts/install hooks.

## Verification (all exit 0, run at head `133e6536d`)

```text
mise run deps                          # fingerprinted npm ci, ok
npm run audit:exposure                 # exposure matrix: CLEAN (working tree; 20 surfaces, 588 reviewed sources)
npm run typecheck                      # turbo: 73 tasks successful
npx vitest run packages/auth-upstream  # Test Files 17 passed (17), Tests 106 passed (106)
```

`npm audit` reports 9 moderate advisories from the existing dependency tree; none are introduced by this bump (they predate it on main and are out of scope for this slice).

## Limits

This is a dependency-slice review: it covers the manifest/lockfile diff, SWA call-site API fit, browser-entry pins, and the exposure-matrix binding. It does not re-review upstream SWA 14 verification internals (origin/RP-ID binding, attestation parsing) beyond the type-level and test evidence above, and it is not a full `npm run verify` run.
