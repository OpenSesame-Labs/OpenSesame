# Delegation and credential export model

These properties cover grant attenuation in the Host domain. They are one
slice of [ADR 0005](../../../docs/adr/0005-authority-handle-connectionref.md)
and [ADR 0046](../../../docs/adr/0046-relayed-execution-and-authorization-inbox.md).
The reviewed source revision, source hashes, and bounded Cargo input projections
are recorded in `coverage.json`. These are drift alarms, not proof that the
review or model is correct. The pre-push registry selects this suite for its
mapped Rust files and domain manifest, for a change in the domain's resolved
root lockfile closure, or for a relevant root workspace manifest change. It
also checks changes that are later reverted or arrive through a merge.
The crate root's reviewed token sequence is independently pinned so module
redirects and re-exports cannot be introduced merely by refreshing coverage
hashes. The currently absent `build.rs` is mapped and its absence is pinned;
enabling a build script or a custom library path requires a separate verifier
and mapping review. The drift check runs before Cargo and again afterwards.

The workspace projection retains the domain's inherited package fields and
workspace dependency keys (including build, development, optional and
target-specific declarations), resolver and global Cargo settings, relevant
patches and package profile overrides, and explicit domain membership. It
uses the union of the before and after lock closures to select named overrides;
unsupported package selectors and workspace member patterns fail closed.
It ignores unrelated workspace dependencies, members, metadata, and
package-specific overrides. Global settings can conservatively select the
suite even when a particular edit would not affect this package.

The lockfile graph includes inactive optional, development and target-specific
packages; it does not encode which features or targets are active. This bounded
projection does not model feature unification caused by other workspace
packages, `.cargo/config*`, the toolchain, dependency build scripts, or environment
inputs. Local path dependencies within the domain closure fail closed until
their source and manifest coverage is explicitly added. Those other inputs
require separate review. The standalone harness has its own
reviewed manifest and lockfile; the drift check requires its direct domain
dependency identities and checksums to match the production lock. The full
standalone and workspace graphs may differ because the latter records unioned
dependency edges, so equality of those graphs is not claimed.

| ID | Requirement | Implementation | Lean theorem |
|---|---|---|---|
| AUTH-D1 | A delegated child cannot add raw credential export, including after any finite chain of checked delegations. | `Grant::validate_attenuation` and `validate_lineage_pointers` in `crates/domain/src/grant.rs` and `grant_attenuation.rs`. | `export_cannot_escalate`, `no_export_gain_in_chain` |
| AUTH-D2 | A replacement cannot add export authority absent from its parent or from the grant it replaces. | `Grant::validate_replacement` in `grant.rs`. | `replacement_cannot_add_export` |
| AUTH-D3 | A child whose issuer field names neither the parent issuer nor its beneficiary is rejected. | `validate_delegator` in `grant_lineage.rs`. | `stranger_cannot_delegate` |
| AUTH-D4 | A bound project scope cannot be dropped or switched to a different project. | `validate_scope_containment` in `grant_lineage.rs`. | `bound_scope_cannot_be_dropped`, `bound_scope_cannot_move` |
| AUTH-D5 | A child cannot drop the parent's proof key or reuse that key for a different beneficiary. | `validate_proof_key_transfer` in `grant_lineage.rs`. | `bound_key_cannot_be_dropped`, `parent_key_cannot_transfer` |
| AUTH-D6 | A child cannot add either of the modeled actions absent from its parent. | `Grant::validate_attenuation` in `grant.rs`. | `child_read_requires_parent`, `child_write_requires_parent` |

`Authority.lean` checks the theorem statements and emits 50 finite cases.
`conformance.rs` feeds those cases to the actual Rust validators, using grants
that satisfy the other checks those validators invoke. The cases include every
Boolean export, replacement and issuer combination; representative
missing/same/different project and key
bindings; and all subsets of the two sample actions. A fresh grant ID is used
for each fixture. The [Rust lock file](Cargo.lock) pins the harness dependencies
separately from the production workspace.

Run with Lean 4.24.0, the repository Rust toolchain, and its usual shared Cargo
cache:

```sh
bash spec/formal/authority/check.sh
```

Set `OPENSESAME_LEAN_BIN` to the Lean executable when it is not on `PATH`.
`CARGO_TARGET_DIR` should name the shared Cargo target directory. The command
fails on Lean warnings such as `sorry`, failed Rust correspondence cases, or a
covered-source hash change. On a covered source change, re-review the mapping
and update the hashes only after rechecking the model. Advance the reviewed
revision only after inspecting the actual source at that revision.

The correspondence check was run against separate scratch mutations that
removed the export, replacement, issuer, scope, dropped-key, transferred-key,
and action guards. Each mutation caused a failing Rust assertion. The unchanged
source passed afterward. Repeat those controls with
`python3 spec/formal/authority/negative-control.py`. It creates a temporary Git
worktree, copies the covered current source into it, restores each mutation,
and removes the temporary worktree afterward. It requires the same Lean and
Rust environment as the main check.

The Lean chain theorem assumes every hop uses the modeled export check. The
code test covers one delegation hop and one replacement in a fixed set of grant
fixtures; it is not a proof that Rust refines Lean for
all strings, grant fields, or all executions. The check does not establish that
root grants are legitimately issued, that the caller is authenticated as the
issuer named in the child, that a newly supplied proof key was cryptographically
possessed, that resources or other constraint dimensions
narrow, that revocations are fresh, that budgets are conserved, or that
concurrent requests cannot race. Those remain separate proof and test targets.
