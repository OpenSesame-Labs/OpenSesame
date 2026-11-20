# Host SPIFFE source-trust selection

A Host listener configured with a `SpiffeTrustDomain` accepts its selected
client trust bundle only from the current source-owned generation. A stored
bundle with the same profile cannot stand in for a source bundle that is
absent after a manager restart. The selected bundle must have the exact
profile label, `SpiffeTrustDomain` kind and configured domain. An ordinary file-backed listener
continues to use its configured generation trust.

`SourceTrustSelection.lean` proves seven obligations about this finite selector:
source-view freshness, presence, kind, profile and configured domain must all
hold, and every complete source input is accepted. The Rust correspondence
checks the 32 Boolean combinations against the actual selection function and,
for a fresh present view, compares all eight kind/profile/domain combinations
with its private production predicate. For a non-SPIFFE kind, safe bundle
constructors cannot attach a domain, so the full selection test uses the same
domainless bundle for both abstract domain bits. The harness supplies stale and
fabricated source views to exercise these branches; this is not a proof of the
manager or of Rust execution. A separate
selector regression checks the returned profile, kind, anchors, CRLs, and
generation against the requested entry in a two-domain source view;
this exact-return behavior is tested rather than proved by the Boolean model.
The separate runtime regression reconstructs the source manager with a stored
collision, checks the actual generation-bound source lookup, and exercises live
TLS with source and stored CAs. It reconstructs a manager over the same
in-memory store; it is not a full operating-system process restart or a real
Workload API test.

The manager's `source_trust(generation)` serializes its lookup with source
activation and rejects a changed generation. The existing TLS handshake and
request guard recheck that generation; operations already admitted are not
rolled back. The design assumes the configured source and the generation
manager's owner API are trusted to publish the source view. This suite does not
persist history or prove that a domain once served remains reserved after
restart. On its own it does not establish peer URI-domain matching, exclusive SPIFFE
selectors, full X.509-SVID validation, or behavior of arbitrary consumers that
read `Generation::trust` directly. Those require separate contracts.

Run `npm run verify:source-trust-selection-formal` after the suite is registered
and reviewed coverage hashes are recorded. The command pins Lean 4.24.0,
checks drift before invoking Cargo, requires exact nonzero test results, and
runs correspondence, the exact-return control and the live regression. Run
[negative controls](NEGATIVE-CONTROLS.md) separately to exercise selected
implementation and runner failures. The source-lifetime suite
must also run when its mapped files change.

Cargo configuration and proof-runner helpers are execution metadata, not
implementation paths that select this suite by themselves. The drift check
records reviewed configuration and helper bytes before Cargo runs. These checks
assume trusted committed and checked-out execution metadata, the selected
toolchain, and already trusted external dependencies. A separate runner-integrity
guard is needed to enforce the execution-metadata assumption across pushes.

Run `python3 -I spec/formal/source-trust-selection/test_drift.py` for scratch
workspace-projection, build-script, and forged-bytecode controls. The suite
checks its reviewed source bytes and Cargo configuration before executing Cargo.
