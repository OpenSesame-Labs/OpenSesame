# Host source-trust history specification

This suite is registered in the pre-push policy on this branch. On commit
`0f964aa7`, the integrated check passed 25 pinned Lean theorem signatures,
21 generated cases, and 77 Linux tests in 16 groups, including the offline
operator action, a real Host startup, and the focused PEM collision witness.
No live database migration or initialization has been performed.

## Security requirements and evidence

| ID | Required behavior and implementation | Model property and evidence |
|---|---|---|
| HIST-I1 | A missing record cannot authorize recovery or a union. Only an explicit complete attestation can create an absent record; it cannot overwrite an existing one. [`source_history.rs`](../../../crates/gateway/src/transport/source_history.rs), [`coordinator.rs`](../../../crates/gateway/src/transport/source_history/coordinator.rs), and [`serve.rs`](../../../apps/cli/src/serve.rs). | `unattested_initialization_refused`, `existing_history_not_replaced`, `missing_history_cannot_union`; real SQLite, offline CLI and Host process startup cases. |
| HIST-U1 | Successful compare-and-set union retains earlier and added names. Stale comparison cannot overwrite a concurrent winner; revision does not decrease. | `stale_compare_changes_nothing`, `prior_name_survives`, `successful_compare_adds_name`, `revision_does_not_decrease`, `retry_preserves_both_writers`; nine Lean-generated cases compared to the SQLite store, plus contention, deletion, durability-setting and restart tests. |
| HIST-P1 | A seeded manager refuses locally supplied bundles for reserved names, including after a source-owner handoff. A new source reserves names before waiting for durable union. | `reserved_name_not_added_by_local_update`, `pending_name_stays_blocked_after_handoff`; real manager and fake Workload API tests. A Host transition case exercises source removal, restart, PEM, managed identity and bindings-only startup. |
| HIST-A1 | Publication requires an acknowledged history write and the same source owner and epoch; wall and monotonic write bounds are exclusive. A provisional generation remains bounded until owner-scoped finalization. | `no_publication_without_receipt`, `stale_owner_or_epoch_does_not_publish`, `elapsed_wait_does_not_publish`, `elapsed_provisional_generation_not_usable`, `observed_provisional_expiry_cannot_finalize`; manager, paused-publication and failure-cleanup regressions. |
| HIST-C1 | Within one process, a manager and started writes hold exclusive ownership. An unresolved aborted write poisons the owner until restart. Detached work has bounded capacity. | `pending_write_blocks_reconstruction`, `retirement_does_not_forget_a_pending_write`, `unknown_write_outcome_fences_successor`, `saturated_write_capacity_refuses`; four model-driven coordinator cases and SQLite worker, cancellation and saturation tests. |
| HIST-F1 | On the supported Unix filesystem, cooperative file-backed Hosts and the offline initializer claim one process-lifetime file lease before opening SQLite. A second claimant is refused. | `occupied_file_claim_refused`, `unrelated_exit_preserves_file_owner`; two Lean-generated claims, same-process and real Host/initializer contention controls. The model assumes one correctly identified filesystem resource and cooperative OS locking. |
| HIST-E1 | A newer **observed** source event supersedes a pending candidate. A denial or reduction withdraws as required; saturation or history failure withdraws and reconnects for a fresh replay. | `observed_event_supersedes_prior_result`; two Lean-generated cases and fake-stream tests for denial, reduction, late completion, saturation and recovery. |
| HIST-R1 | Stored-profile adoption quarantines reserved enabled names, preserves unrelated trust and rechecks the exact generation before installation. A generation change causes reconciliation even when the stored revision is unchanged. | `reserved_stored_name_is_quarantined`, `changed_generation_requires_reconciliation`, `stale_merge_cannot_replace_new_generation`; four model-driven adoption cases and lifecycle/status/rotation barrier tests. |

The 25 theorem signatures and proposition types are pinned in
[`required-theorems.lean`](required-theorems.lean); definitions are in
[`SourceTrustHistory.lean`](SourceTrustHistory.lean). On `b1016221`, the
integrated runner checked 25 theorem signatures, 21 finite correspondence
cases, and 76 Linux tests in 16 groups, including process-level lease and Host
startup cases. The added focused PEM witness passed separately; the complete
suite needs a rerun with it. Windows-only refusal cases remain unrun.
Lean proves the stated abstract properties, not refinement of all Rust or
SQLite executions. A storage receipt is a trusted model input, not a Lean
proof of disk persistence. The finite tests, a lease, and a theorem are
different kinds of evidence.

This suite covers durable reservations and their adoption by the Host's
generation manager and stored-trust lifecycle. Its Host-process case exercises
bindings-only startup and an ordinary HTTP endpoint; it does not prove that a
secure listener or request guard enforces the selected trust. The separate
[source-lifetime](../source-lifetime/README.md) and
[peer-domain](../spiffe-peer-domain/README.md) suites state their own listener
and peer-verification properties and limits.

The persistent record, coordinator, and file lease belong to this history
contract; the other suites do not claim persistence across manager or process
restart. Conversely, TLS client/server configuration, signing and request
guards, and source-bundle selection are covered by those other suites rather
than this history selector. The Host boot entry remains an input here because
the process regression exercises its plain serving path.

## Assumptions and limits

The operator must attest the complete historical set; software cannot recover
unknown names accepted by an older binary. Startup cannot automatically treat a
missing record as empty or recreate it from a saved input file. The separate
[operator procedure](../../../docs/operators/source-trust-history.md) describes
fresh install and upgrade; all other Host processes and writers must be stopped
before attestation. The one-shot property lasts while the row exists. Explicit
reinitialization after deletion and deletion/recreation of identical bytes are
not detected.

All managers in one process must be created through the consuming startup
permit, and raw in-process store APIs and other trusted callers must not bypass
it. The manager retains the permit across its Arc lifetime; started SQLite
workers retain it until an outcome. A completed SQLx future is assumed unable
to mutate the database later. The process-local slot serializes all Host
databases in that process. The separate file lease fences cooperative current
Hosts and initializers using the same supported database path and lock directory;
it is retained until the process exits, even after a failed startup or teardown.
A process cannot claim that same file again without restarting. This is not a
distributed lock for older binaries, raw SQLite users or noncooperative writers.
The Bitwarden import and `sync rebind-legacy` CLI commands also open the Host
database without this lease; their current operations write other tables and
can run normal migrations. Their continued separation from trust history and
profiles is a trusted-writer assumption, not a proved property.
Configured transport and offline initialization fail closed on Windows until
the corresponding file-identity lease is validated; an unconfigured Windows
Host keeps its previous behavior. The Windows-only CLI controls in
[`entry_startup.rs`](../../../apps/cli/tests/entry_startup.rs) cover both startup
paths and initializer refusal, but have not been run on a Windows runner.
The operator must use a trusted local filesystem and directory, without database
or lock replacement or file-only bind aliases. The implementation does not
prove the inode behind each SQLx pool connection. A process restart assumes the
prior process and its database work have ended.

The reservation applies to bundles in the Host's generation manager. The
trusted-ingress originating-client PEM bundle is constructed separately and
is not checked against source history, even though its forwarded evidence has
the textual profile name `originating-clients`. Source ownership must not be
inferred from that text alone. Current certificate-bound token and enrollment
budget checks use the originating leaf thumbprint; service binding uses the
direct ingress. Any future consumer that relies on the originating profile
name needs separate review. The model does not prove isolation for that
independent evidence path.

The record must remain the same continuously trusted store. A restored older
backup, a different previously initialized database, or an external write may
lose names. An independent continuity/rollback witness or separately reviewed
complete-union migration is required to cover those cases; neither is provided
here. Each read and write checks the same SQLite connection for a persistent
journal and `synchronous` at least FULL. A close/reopen test is not a process
kill, power-loss, filesystem-flush, or rollback test; SQLite, the driver and
filesystem must honor their documented contracts.

The stream model begins when an event is observed by the source task. It does
not bound remote event delivery, task scheduling, or a checked operation after
its last local check. Use-time fences still bound accepted material. Recovery
after a history failure depends on scheduling, the Workload API replaying its
snapshot, and storage availability; the model does not prove liveness.

Quarantining stored names is conservative. PUT refuses even an unchanged
enabled quarantined name; an operator must remove or disable it before editing
another profile, subject to the existing binding-removal guard. A deployment
bundle that collides at initial startup prevents the management endpoint from
starting and needs an offline cleanup or reviewed namespace migration. Trust
status samples the stored revision, applied epoch and serving generation
separately, and is not a cross-replica atomic revocation decision. A canceled
PUT can commit the store before local activation; remote changes and later
refresh are eventually consistent.

## Reproduction and remaining checks

`bash spec/formal/source-trust-history/verify.sh --model-only` checks the independent
theorem signatures and allowed axioms and emits finite traces. `verify.sh`
checks those traces and named real-code tests with pinned local Lean and Rust
toolchains. It also runs the runtime, offline CLI, and real Host-process startup
tests. The integrated Linux run passed on `b1016221` after the lint changes,
but must be repeated after adding the focused PEM witness.
The Cargo freshness check preserves the caller's Cargo network policy.
When offline mode is selected, it refuses an environment whose required
dependencies are not cached. It also refuses a repository-local standalone
dependency when its locked metadata cannot be resolved; it does not create or
update that dependency's lock.
It compiles declared repository-local targets, checks Cargo's
no-run artifact records and workspace compiler log, rechecks reviewed inputs,
and then executes the same ordinary Cargo command. It clears `RUSTC_WRAPPER`
only in its child processes. This relies on a trusted pinned Cargo/rustc
toolchain, reviewed Cargo configuration and runner metadata, and no concurrent
source, configuration or target-cache mutation between checks. It does not
establish that older proof suites already pin every Cargo configuration input.
The common helper's interrupted-build and same-path replacement regressions
passed separately.
`python3 -I spec/formal/source-trust-history/negative-controls.py` is a
scratch-copy mutation runner. It leases a worktree-specific scratch location,
authenticates the baseline coverage, binds
exactly one declared source replacement to a temporary coverage record, and
requires the targeted test to pass before and after while the mutant fails at
the specified assertion. The first eight implementation mutations and restored
baselines passed on `b1016221`. The ninth initially failed at an earlier
assertion; after adding a focused PEM witness, the final three controls used the
same scratch and witness functions and passed with restored baselines. The
production implementation did not change between those runs. This is split
evidence rather than one uninterrupted run on the updated tree; independent
review remains pending. The scratch runner explicitly selects offline Cargo
and therefore needs its dependencies cached in advance.
One private checkout per worktree can remain after a run; the next lease
cleans it only after outstanding lock holders have exited.
Pass `--drift-only` to run just the source, migration-module grammar and
inventory, Cargo-target, and build-script drift controls without invoking Cargo.

The [hosted pre-push run](https://github.com/OpenSesame-Labs/OpenSesame/actions/runs/44190148761)
completed all six selected suites on source `0f964aa7` plus a temporary CI
workflow, including the history suite and live NATS tests. The earlier local run
had stopped under process exhaustion. Repeat the complete pre-push after
restacking onto current main, and complete independent review. The staged
exposure matrix has passed.
The registry, requirements, independent minimum, and affected source mappings
include this suite. Native-Git tests cover selection for implementation
changes, including reverted pushed changes, while proof-only changes do not run
suites. Registering files or observing passing finite tests does not itself
establish implementation-to-model refinement.

The registered command is `npm run verify:source-history-formal`,
running this suite's `verify.sh`. Its implementation mapping must cover the
offline CLI and Host startup, SQLite history and owner coordination, source
publication and supersession, manager reservations, stored-trust reconciliation
and status, and their reviewed module, configuration and migration inputs.
The command tests the CLI, gateway, SPIFFE and transport crates, so its lock
projection must use the CLI root and the successor policy's multipackage
workspace projection. Pin the complete local manifest closure, its ancestor
workspace manifests, and corresponding optional build scripts; reject missing,
ambiguous or unsupported dependencies instead of treating them as unchanged.
The independent target inventory fixes the directly reviewed library roots,
the `opensesame` binary and four named integration tests. A rehashed manifest
cannot redirect one of those targets to a different file.
The Host opens its database by running the embedded migration list before
loading history. Pin `crates/storage/src/migrations.rs` and every SQL file it
currently includes. The drift checker consumes the entire module as a strict
literal-list grammar and compares its ordered paths to an independent inventory;
alternate expressions or other unparsed declarations fail closed until reviewed.
A separate trusted pin covers the storage crate root, where module redirection
or macro shadowing could otherwise change how that grammar is compiled.
A new SQL file that is not included in the list is not executed.
The lock closure is conservative about inactive optional, development and
target-specific dependencies. It is not an exact active-feature build graph.
The historical selector reads policy and manifests as data, while the trusted
controller verifies the runner and helper provenance. Native-Git regressions
must cover a mapped edit, an edit later reverted, an unrelated change, and a
proof-only change, including preservation of successor suites on restack.
