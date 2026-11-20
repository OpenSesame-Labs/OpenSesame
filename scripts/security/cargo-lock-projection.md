# Cargo lock graph projection

This read-only Python 3.11+ utility compares resolved package graphs from two
Cargo.lock blobs. It does not run Cargo or execute lockfile content. The
primary command, and the closure the SPIFFE drift check hashes
(`projection_sha256` with no dependency filter), is the full graph rooted at
`opensesame-spiffe-source`:

```sh
python3 scripts/security/cargo-lock-projection.py \
  --root opensesame-spiffe-source BEFORE.lock AFTER.lock
```

That closure includes the root package, every direct dependency, and every
package reachable from them. For this workspace it includes `shuttle` through
`opensesame-domain` even when `shuttle` is inactive for the SPIFFE build. A
change on that inactive edge changes the fingerprint. The lockfile cannot show
that the edge is inactive, so the SPIFFE gate treats it as a real closure
change.

`--dependency spiffe` selects a different, narrower closure: exactly one direct
edge named `spiffe` on the unique source-less root, then only packages
reachable from that edge. The root package's own version and its other edges,
including the inactive `shuttle` edge, are outside that selection. The SPIFFE
drift check does not hash this narrower closure.

```sh
python3 scripts/security/cargo-lock-projection.py \
  --root opensesame-spiffe-source --dependency spiffe BEFORE.lock AFTER.lock
```

A named dependency must resolve to exactly one direct edge of the unique
source-less root package. By default, missing or ambiguous roots or selected
dependencies are errors.

The push selector passes `--allow-absent` when comparing history: a genuinely
absent root or direct edge is represented as an absent graph. Introduction or
removal therefore reports a change, and two absent graphs are unchanged. The
entire lockfile is validated first; malformed or ambiguous references and
unreadable or absent lockfiles still fail closed.

Success prints exactly one JSON object, `{"changed":false}` or
`{"changed":true}`, and exits 0. An unreadable or malformed lockfile, unsupported
format, unresolved or ambiguous reference, or invalid selection exits nonzero,
writes a diagnostic to stderr, and emits no success JSON. The caller must fail
closed: never treat a nonzero exit, process failure, invalid JSON, or missing or
non-boolean `changed` field as an unchanged graph. The Node hook should create
its own temporary files from the intended committed blobs, pass their paths as
argument-vector entries rather than shell text, and remove them afterward.

Each projection includes every reachable package's name, exact version,
source, checksum, and its resolved edges. It resolves dependency name, optional
version, and optional source qualifiers against the whole lockfile, rejecting
ambiguous, unresolved, duplicate, or malformed identities and edges. It
validates references across the entire lockfile before selecting a closure.
Equivalent dependency qualifiers, package ordering, dependency ordering,
comments, and formatting do not change the result. A valid unrelated package
change is excluded from a named dependency closure. Cycles are supported.

The supported input is Cargo.lock format 3 or 4 with package fields `name`,
`version`, `source`, `checksum`, and `dependencies`; unknown package fields and
legacy metadata checksums fail closed. Source-less packages represent Cargo
path/workspace packages, but Cargo.lock alone cannot establish workspace
membership or distinguish two path packages with the same identity. The
non-graph lockfile metadata and `patch.unused` entries are not projected.

Cargo.lock also does not encode which features, targets, dev dependencies, or
build dependencies are active for a particular command. The graph is therefore
a conservative resolved closure, not an active build plan. Compare relevant
Cargo manifests, workspace patch and replacement definitions, Cargo config,
toolchain settings, and other build inputs separately. A matching graph does
not prove source integrity or the security property being checked.

The full `opensesame-spiffe-source` closure above is what
`spec/formal/spiffe/check-drift.py` hashes. The inactive `shuttle` edge is
inside that hash. `--dependency spiffe` leaves it out. A change on that
inactive edge therefore reports a change and selects the SPIFFE suite as a
conservative false positive; the lockfile alone cannot safely filter it out.
A matching full-closure fingerprint still leaves manifests, Cargo
configuration, patches, and the toolchain to a separate review.

Run the isolated tests with:

```sh
python3 scripts/security/test_cargo_lock_projection.py
```
