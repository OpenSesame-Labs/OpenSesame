# Source-lifetime negative controls

Run `python3 spec/formal/source-lifetime/negative-controls.py` with the pinned
Rust and Lean toolchains and the Cargo dependencies available offline. It
archives the current commit to a temporary directory, copies the active source,
proof, and Cargo inputs into that scratch tree, and checks that the unchanged
Lean-to-Rust correspondence passes.

The script then rejects empty and incomplete vector sets, duplicate input keys,
a noncanonical numeric input, a malformed Boolean, and an altered expected result. It separately mutates the
scratch Rust manager to allow a stale epoch, replace a source identity, replace
source-owned trust, or accept exact deadline equality. Each mutant must fail in
the named correspondence test with an assertion; a compiler failure or a
zero-test run is not a pass. It restores the scratch file and reruns the
unchanged correspondence. The live manager source hash is checked on exit.

These controls show that the test detects the named defects. They do not prove
that every defective implementation or unexpected input is detected. See the
[suite scope and clock assumptions](README.md).
