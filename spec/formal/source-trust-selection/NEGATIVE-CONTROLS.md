# Source trust selector negative controls

Run `python3 -I spec/formal/source-trust-selection/negative-controls.py` after
activating the pinned Lean and Rust toolchains. It archives the committed base
and overlays the current tracked and untracked changes in a temporary
directory, including deletions, with Cargo incremental compilation disabled.
It rejects a nonempty index so a staged change cannot be omitted. It runs the
complete unmodified selector suite before and after the controls.

The controls deliberately select the first foreign source entry, ignore the
kind check, ignore the profile-label check, and turn a stale source error into a
missing result. The corresponding real-selector tests must fail. An empty Lean
vector set and a Cargo command that reports zero successful tests must also be
rejected. The script checks the expected test and diagnostic; a compiler error
or an unrelated failure does not count as a caught mutant. It verifies the live
selector bytes remain unchanged. These controls test selected guard and harness
failures, not every possible implementation defect.

The negative-control command also runs `test_snapshot.py`, which checks scratch
overlays, deletions, unsafe paths and staged-index refusal in an isolated
temporary Git repository. It can be run independently with
`python3 -I spec/formal/source-trust-selection/test_snapshot.py`.
