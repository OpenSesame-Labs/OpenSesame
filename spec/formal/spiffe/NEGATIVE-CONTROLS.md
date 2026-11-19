# SPIFFE negative controls

Run `python3 spec/formal/spiffe/negative-controls.py` from the repository root
with the pinned Lean and Rust toolchains on `PATH` and the repository's Cargo
dependencies already cached. The script forces `CARGO_INCREMENTAL=0` and
`CARGO_NET_OFFLINE=true`. Set `OPENSESAME_LEAN_BIN` if the pinned Lean executable
is not on `PATH`.

The controls archive the checked-out commit into a disposable directory, then
copy the active SPIFFE crate, its local dependency crates, Cargo manifests,
suite, shared proof checker, and lockfile projection helper into that directory.
They first run the unmodified `verify.sh`, generate vectors with the shared
Lean checker, and alter one Rust source expression at a time in the disposable
copy. Each named witness must fail with its expected assertion or timeout;
compiler errors, an unexecuted test, a successful mutant, and unrelated test
failures do not count. The script restores each scratch file, reruns the
unmodified verification suite, checks that all live test-input files still
match their starting hashes, and deletes the scratch tree. Cargo's configured target directory is reused;
no live repository source is edited.

| Mutant | Required detecting checks |
|---|---|
| Treat `PERMISSION_DENIED` as an outage. | Lean-vector correspondence and the fake-API stream-denial regression. |
| Treat `UNAUTHENTICATED` as an outage. | Lean-vector correspondence and the fake-API reconnect-denial regression. |
| Treat an unparseable snapshot as an outage. | Lean-vector correspondence and the regression with an omitted gateway and malformed worker. |
| Keep all old anchors whenever their domain remains present. | Trust-set vectors and the rejected-profile/removed-anchor regression. |
| Compare incoming trust with itself instead of active trust. | The rejected-profile/removed-anchor integration regression, exercising the source wiring. |
| Report a credential configured at its exact deadline. | Status correspondence vectors and the explicit status-boundary unit test. |
| Extend the stored outage deadline on a retry. | Deadline correspondence vectors and the rejected-profile reconnect regression. |
| Ignore the outage deadline while opening a stalled RPC. | The stalled-RPC integration regression, exercising the timer wiring. |
| Rename the required Lean correspondence test so Cargo matches zero tests. | The normal `verify.sh` guard rejects the otherwise successful zero-test result before the source-drift check. |

These controls demonstrate that the named tests detect these deliberately
selected failures. They do not establish that all unsafe variants are detected,
or do they prove SDK, cryptographic, scheduling, clock-jump, transport-sink,
or concurrent-execution refinement. The fake-API tests are distinct from the
separately executed real-SPIRE reference test.
