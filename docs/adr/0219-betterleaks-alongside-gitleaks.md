# ADR 0219 — Scan with Betterleaks alongside gitleaks, and resolve findings by reviewed, narrowly scoped exemption

- **Status:** Accepted
- **Date:** 2026-11-09
- **Operating contract:** [Tooling evaluation](../security/tooling-evaluation.md)

## Context

gitleaks 8.x is the repository's secret scanner. Betterleaks is its successor
engine by the same authors. It reads `.gitleaks.toml` and `.gitleaksignore`,
and adds rules gitleaks does not ship (`generic-password`,
`generic-credential-uri`), token-efficiency filtering, and optional live
validation.

A first Betterleaks scan reported 711 working-tree findings against 233 for
gitleaks. Reading every one, none was a live credential: they were test
passwords, `user:pw@host` fixtures, UI label strings containing the word
"password", SHA-256 fingerprints in the exposure matrix, development
placeholders, and WebAuthn PRF error codes that collide with the Proof API
key prefix. The volume is the hazard: a scanner that needs 700 hand-written
exceptions trains people to add exceptions without reading.

The existing working-tree review manifest binds each exception to the SHA-256
of the whole file. That is precise but brittle for a regenerated file: the
manifest's rows for `tools/security/exposure-matrix.json` no longer match its
current bytes, so the gitleaks working-tree gate reports 95 unreviewed
findings there at the time of writing.

## Decision

1. **Run Betterleaks as `npm run audit:betterleaks`, next to gitleaks, not in
   place of it.** Pinned and checksum-verified by
   `scripts/dev/install-betterleaks.sh`; scheduled over full history in
   `security.yml`. gitleaks and its release-check wiring are unchanged.
2. **Detection only.** The gate never passes `--validation`. A candidate secret
   is never sent to a provider API from a scan. Reports go to a private
   directory outside the checkout, as for every other audit gate.
3. **One config surface per scanner.** `.betterleaks.toml` extends
   `.gitleaks.toml` (path pruning, remediated commits) and adds exemptions.
   It must not set a top-level `filter`: that replaces the built-in default
   filters instead of adding to them.
4. **An exemption names a rule and is as narrow as the review.**
   - Provider-specific rules are never exempted by path.
   - The three generic rules are exempted by test-fixture path class only.
     Directory classes are rooted at the product directories, so
     `scripts/test/**/third_party/` stays scanned.
   - Anywhere else, an exemption is exact file AND exact value or letters-only
     shape, so a real credential in the same file is still reported.
   - A protected source is not edited to add an inline marker. Its digest is
     bound by the exposure matrix, so the exemption goes in config.
5. **History is immutable, so it is fingerprinted, never path-exempted.**
   Fingerprints bind one commit, path, rule and line.
6. **An unverified credential-shaped finding stays visible.** Four historical
   `tailscale-api-key` hits are hand-built lookalikes by structure, but
   issuance could only be checked by sending them to the provider. They are
   left reported; history findings warn unless
   `OPENSESAME_BETTERLEAKS_HISTORY_FAIL=1`.

## Consequences

- Generic-rule coverage inside test-fixture paths is lost. An unprefixed
  secret that only a generic rule can see, such as a raw AWS secret access key
  pasted into a test file, is not reported there. Provider-prefixed tokens still
  are. This is the price of a gate that is not ignored.
- `.betterleaks.toml` exemptions are reviewed in the diff with their stated
  evidence; there is no manifest to regenerate when an unrelated line in a
  listed file changes.
- Upgrading Betterleaks can add rules. Change the pin and every digest in the
  installer together, run the gate, and re-triage.
- Wiring Betterleaks into the release-qualification checks would also require
  registering `.betterleaks.toml` as scanner policy there. That is deliberately
  not done here.
