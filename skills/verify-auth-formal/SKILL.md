---
name: verify-auth-formal
description: Check and maintain OpenSesame's Lean models and implementation correspondence for authentication, authorization, federation, replay prevention, delegation, approval binding, SPIFFE withdrawal, source-owned transport lifetime, and Host source-trust selection. Use when covered code or its security requirements change, or when asked to verify or extend these proofs.
---

# Verify authentication and authorization properties

Read [the coverage register](../../docs/security/formal-auth-verification.md)
and [the proof registry](../../spec/formal/proof-registry.json) first. The
registry maps implementation paths to their Lean model and command. Each
suite's README and `coverage.json` identify its requirements, assumptions,
implementation, reviewed revision, source hashes, and reproducible checks. The
checks cover only those stated scopes.

1. Trace a change through the real source, callers, and normative requirement.
   For a new property, add its ID, threat, assumptions, implementation symbols,
   theorem or model-check property, evidence, and status to the register. Keep
   unmodeled properties explicitly unproved.
2. Install Lean 4.24.0, the repository's Node dependencies, and the pinned Rust
   toolchain when a Rust suite is involved. Run each affected command in the
   proof registry. If Lean is outside `PATH`, set `OPENSESAME_LEAN_BIN` to its
   absolute path. A missing tool or failed command is blocked, never a pass.
   The pre-push hook selects affected suites; release qualification runs all.
3. If a covered file changed, inspect whether its model still describes it.
   Update the property, model, and conformance cases as needed. Only after that
   review, update the corresponding SHA-256 in the suite's `coverage.json`.
   Advance its reviewed revision only after inspecting source at that commit.
   The hash check catches drift, not dishonest or incomplete review.
4. Follow the suite's negative-control instructions. On a scratch change,
   deliberately break a covered guard in real code and confirm a relevant
   assertion fails. Restore the source and rerun to the prior result. A check
   that only passes is a draft; report a counterexample instead of weakening
   the property to make it pass.
5. Report theorem and test results, actual assumptions and bounds, the
   reviewed source revision, any drift or counterexample, and unproved areas.
   Keep Kani, integration, browser and security checks applicable to the change.

Do not present Lean's proof of a separate model, the finite correspondence
matrix, TypeScript proof tokens, or a source hash as a proof of all production
code, cryptography, sessions, or concurrent behavior.
