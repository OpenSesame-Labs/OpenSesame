# SPIFFE peer-domain negative controls

After activating the pinned Lean and Rust toolchains, run
`python3 -I spec/formal/spiffe-peer-domain/negative-controls.py`. The script
archives the committed predecessor and overlays tracked and untracked changes
into a temporary checkout, including deletions. It rejects a nonempty index
so a staged change cannot be omitted. It runs the complete unmodified suite
before and after the controls with Cargo incremental compilation disabled.

The controls remove the inbound domain check for both peer evidence and the
live service-admission path, make a thumbprint an
authorizing selector, omit thumbprint revocation, widen a forwarded ingress,
allow a source-owned domain to be relabeled, accept an outbound reference in
the wrong domain, accept raw forwarded ingress facts, ignore the Host's
configured source domain, and enable resumption for authenticated clients.
Each mutant must fail its named behavior or finite
correspondence test with the expected diagnostic; compilation errors and
unrelated failures do not count. An empty vector file and a Cargo result that
reports zero tests must also be rejected. The script checks that the live
implementation bytes are unchanged.

These controls exercise selected implementation and runner failures. They do
not establish a Rust refinement proof, cover every possible mutation, or
replace the chain-verification and integration tests described in the suite.

The negative-control command also runs `test_snapshot.py`, which checks scratch
overlays, deletions, unsafe paths and staged-index refusal in an isolated
temporary Git repository. It can be run independently with
`python3 -I spec/formal/spiffe-peer-domain/test_snapshot.py`.
