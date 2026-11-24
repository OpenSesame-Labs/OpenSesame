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
inputs. Path packages declared by the workspace manifest or a patch are hashed
in `coverage.json` and mapped as proof inputs. Any other path dependency in the
domain closure fails closed until its source and manifest coverage is explicitly
added. Those other inputs
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
| AUTH-D4 | A bound project, environment, connection, actor, client, or actor-instance scope cannot be dropped or switched to a different value. | `validate_scope_containment` in `grant_lineage.rs`. | `bound_scope_cannot_be_dropped`, `bound_scope_cannot_move` |
| AUTH-D5 | A child cannot drop the parent's proof key or reuse that key for a different beneficiary. | `validate_proof_key_transfer` in `grant_lineage.rs`. | `bound_key_cannot_be_dropped`, `parent_key_cannot_transfer` |
| AUTH-D6 | A child cannot add either of the modeled actions absent from its parent. | `Grant::validate_attenuation` in `grant.rs`. | `child_read_requires_parent`, `child_write_requires_parent` |
| AUTH-D7 | An accepted delegation or replacement narrows every constraint dimension: an active child window lies inside the parent's (`interval_contains`), a required assurance is kept at no lower known rank, an authentication age is kept at no larger value, a network or audience list that is set is neither cleared nor widened, a parameter-rules digest is kept, offline use never rises, every parent budget meter is kept at a value in `[0, ceiling]` and no unmetered key appears, and re-delegation depth never grows. Over any finite chain of checked hops the leaf window lies in the root's and the leaf depth is bounded by the root's maximum. | `validate_constraint_attenuation` (and `validate_constraint_narrowing`) in `grant_attenuation.rs`, `validate_budget_attenuation` in `grant_budgets.rs`, the depth checks of `validate_lineage_pointers`, and the audience and replacement checks in `grant.rs`. | `window_cannot_widen`, `assurance_cannot_weaken`, `auth_age_cannot_widen`, `networks_cannot_widen`, `parameter_rules_cannot_change`, `offline_cannot_widen`, `budget_meter_cannot_drop_or_rise`, `budget_key_cannot_appear`, `audiences_cannot_widen`, `replacement_narrows_both`, `chain_window_within_root`, `chain_depth_bounded` |
| AUTH-D8 | Every resource a child's selectors permit is permitted by some parent selector, for all selector and resource strings. | `resource_pattern_matches` and `Grant::permits_resource` in `grant.rs`; `resources_attenuate` in `grant_attenuation.rs`. | `selector_containment_sound`, `resources_cannot_widen` |
| AUTH-D9 | A replacement is bound by the fences of the child it replaces even where the parent set none: a set audience list is neither cleared nor widened, a scope binding is neither dropped nor moved, and a proof key is not dropped. | `Grant::validate_replacement` in `grant.rs` (fixed 2026-11-24; see below). | `replacement_keeps_current_audiences`, `replacement_keeps_current_scope`, `replacement_keeps_current_key` |

`Authority.lean` checks the theorem statements and emits 3,062 finite cases.
`conformance.rs` feeds those cases to the actual Rust validators, using grants
that satisfy the other checks those validators invoke. The cases include every
Boolean export, replacement and issuer combination; representative
missing/same/different bindings for every scope dimension
`validate_scope_containment` checks (project, environment, connection, actor,
client, and actor instance) and for proof keys; and all subsets of the two
sample actions. Each of the six scope vectors is applied once per dimension.
A fresh grant ID is used for each fixture.
For AUTH-D7 it emits, per constraint dimension, every parent/child pair over
that dimension's abstract domain (four not-before and three expiry instants,
including inverted intervals; absent and all five assurance names, one of them
unknown; four authentication ages; four audience and network lists; three
digests; three offline modes; 25 two-key budget maps with negative, zero and
over-ceiling values; four depths and four maximum depths) with the other
dimensions fixed, 1,127 pairs in all. Each pair is run through
`Grant::validate_attenuation` and, as a current child and replacement under a
wide parent, through `Grant::validate_replacement`. For AUTH-D8 it emits
19 selector strings (including `a/`, a bare `*`, `/*`, `:*`, mixed separators
and a multi-byte character) and compares every ordered pair with
`resources_attenuate`, attenuation of a one-selector grant, `permits_resource`
and `resource_pattern_matches`. For AUTH-D9 it emits 18 parent, current and
replacement binding triples, each applied to all six scope dimensions, and 18
proof-key triples. The [Rust lock file](Cargo.lock)
pins the harness dependencies separately from the production workspace.

Run with Lean 4.24.0 and the repository Rust toolchain:

```sh
bash spec/formal/authority/check.sh
```

Set `OPENSESAME_LEAN_BIN` to the Lean executable when it is not on `PATH`.
The covered `conformance.rs` proof input is explicitly selected as the
`authority-conformance` Cargo binary; changing that proof input alone does not
select a pre-push implementation proof. The harness uses a private temporary
Cargo target because its domain dependency is outside the harness workspace.
Negative controls place that target inside
their leased scratch checkout. A surviving compiler keeps the lease after an
interruption, and a later run can clean the checkout once the compiler exits.
The command
fails on Lean warnings such as `sorry`, failed Rust correspondence cases, or a
covered-source hash change. On a covered source change, re-review the mapping
and update the hashes only after rechecking the model. Advance the reviewed
revision only after inspecting the actual source at that revision.

The correspondence check was run against separate scratch mutations that
removed the export, replacement, issuer, scope, dropped-key, transferred-key,
and action guards, and (2026-11-24) the validity-window, not-before,
assurance, authentication-age, network, digest, offline, budget-ceiling,
budget-key, depth, audience, replacement-narrowing, selector-boundary,
pattern-length, replacement-audience, replacement-scope and replacement-key
guards. Each mutation caused a failing Rust assertion. The unchanged
source passed afterward. Repeat those controls with
`python3 spec/formal/authority/negative-control.py`. It requires an empty Git
index, archives the committed tree into a locked scratch checkout, overlays the
current modified and untracked files without following symlinks, and restores
each mutation. It requires the same Lean and Rust environment as the main check.

Fixed gap (2026-11-24): writing AUTH-D9 showed that `validate_replacement`
re-checked a replacement against the current child only on actions,
resources, export, re-delegation depth and the constraint dimensions. Under an
unrestricted parent a replacement could clear the current child's audiences,
drop or move its scope bindings, or drop its proof key. The validator now
re-runs the audience rule, `validate_scope_containment` and
`validate_proof_key_transfer` against the current child; regressions
`adversarial_a_replacement_cannot_drop_the_current_childs_fences` and
`contract_a_replacement_may_name_audiences_under_an_unrestricted_child` in
`grant_unit_tests.rs` fail before the fix and pass after it. The broker's
`narrow_delegation` copies those fields from the current grant, so no shipped
endpoint reached the widening.

AUTH-D8 models strings as character lists; Rust compares UTF-8 bytes. They
agree because every byte the code inspects at a computed index (`/`, `:`, `*`)
is ASCII, an ASCII byte never occurs inside a multi-byte sequence, and a
length comparison after a successful prefix test only asks whether the
remainder is non-empty. The multi-byte selectors in the matrix exercise this;
the argument itself is review, not proof.

The Lean chain theorem assumes every hop uses the modeled export check. The
code test covers one delegation hop and one replacement in a fixed set of grant
fixtures; it is not a proof that Rust refines Lean for
all strings, grant fields, or all executions. The check does not establish that
root grants are legitimately issued, that the caller is authenticated as the
issuer named in the child, that a newly supplied proof key was cryptographically
possessed, that revocations are fresh, that budgets are conserved while
spent (AUTH-D7 concerns the ceilings a grant names, not what an enforcer
spends), or that concurrent requests cannot race. The constraint and resource
correspondence is exhaustive per dimension over the abstract domains above,
with the other dimensions held fixed; that the Rust conjunction of dimension
checks matches the model's, and that the matrix's representative strings,
instants and identifiers stand for all values, rests on review. A parameter
rules digest is compared for equality only; whether two different digests
denote a narrowing is not modeled (the code refuses any change). Those remain
separate proof and test targets.
