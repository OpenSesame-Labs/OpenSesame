# Source trust selector negative controls

Run `python3 -I spec/formal/source-trust-selection/negative-controls.py` after
activating the pinned Lean and Rust toolchains. It archives the committed base
and overlays the current tracked and untracked changes in a temporary
directory, including deletions, with Cargo incremental compilation disabled.
It rejects a nonempty index so a staged change cannot be omitted. It runs the
complete unmodified selector suite before and after the controls.

The controls deliberately select the first foreign source entry, ignore the
kind check, ignore the profile-label check, and turn a stale source error into a
missing result. The corresponding production selector or its directly tested
kind/profile/domain predicate must fail; the latter also receives abstract fact
combinations that safe bundle constructors cannot produce. An empty Lean
vector set and a Cargo command that reports zero successful tests must also be
rejected. The script checks the expected test and diagnostic; a compiler error
or an unrelated failure does not count as a caught mutant. It verifies the live
selector bytes remain unchanged. These controls test selected guard and harness
failures, not every possible implementation defect.

The negative-control command also runs `test_snapshot.py`, which checks scratch
overlays, deletions, unsafe paths and staged-index refusal in an isolated
temporary Git repository. It can be run independently with
`python3 -I spec/formal/source-trust-selection/test_snapshot.py`.

For the separate NATS suite, install the pinned server fixture first and run
`python3 -I spec/formal/source-trust-selection/negative-controls.py --nats`.
Its scratch mutants include bypassing the one-use verifier, enabling TLS
resumption, omitting either injected-material selector, and ignoring a
retry-only or nonassertive environment setting. The reconnect controls expect
the live TLS-to-NATS test to fail for its named assertion or bounded-worker
timeout, not merely for a compilation or unrelated failure. Empty, missing,
duplicate and malformed handshake vectors must also
fail. A no-resumption claim depends on the ordinary-client control first
demonstrating actual TLS resumption with the same proxy and protocol version.
Separate mutants remove the injected retry cap, alter an ordinary retry limit,
ignore the selected cap in the NATS options, and extend the old-drain timeout.
The eight retry vectors also reject missing, duplicate and malformed rows.
These are selected mutation witnesses; they do not prove all Rust executions,
network schedules, source freshness or cryptographic behavior.

The fixture checks refuse a missing or corrupt cached server before Cargo and
verify that the proof runner does not fetch it. They are shared with the
source-only `test_drift.py` helper and run inside the scratch controls; the
release tool setup is the separate, explicit download path.
