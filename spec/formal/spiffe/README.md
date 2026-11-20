# SPIFFE withdrawal and outage policy

This suite records the decisions in
[`source.rs`](../../../crates/spiffe-source/src/source.rs),
[`source_policy.rs`](../../../crates/spiffe-source/src/source_policy.rs),
[`bundles.rs`](../../../crates/spiffe-source/src/bundles.rs),
[`outage.rs`](../../../crates/spiffe-source/src/outage.rs), and
[`status.rs`](../../../crates/spiffe-source/src/status.rs). The governing
contract is [ADR 0132 §12](../../../docs/adr/0132-optional-mtls-and-workload-identity.md),
as refined by [ADR 0223](../../../docs/adr/0223-spiffe-withdrawal-under-ambiguous-snapshots.md).

| Requirement | Lean theorem | Implementation evidence |
|---|---|---|
| No identity, permission or authentication denial, an empty SVID list, a missing required bundle, or an unparseable snapshot withdraws the model state. | `no_identity_withdraws`, `permission_denial_withdraws`, `unauthenticated_withdraws`, `empty_snapshot_withdraws`, `missing_bundle_withdraws`, `malformed_snapshot_withdraws` | The actual SDK-error classifier is compared with model decisions. Fake Workload API tests exercise denial on opening and streaming, malformed unrelated SVIDs, and omission combined with malformed data. |
| `UNAVAILABLE`, EOF and other non-denial transport failures take the outage path. | `transient_transport_is_outage`, `outage_preserves_active` | Classifier vectors and synthetic reconnect tests. |
| A rejected parsed candidate retains an active model state when old trust remains present; each of the three modeled old anchors causes withdrawal if removed. Only activation recovers a withdrawn state. | `rejected_preserved_trust_keeps_active`, `missing_anchor_withdraws`, `missing_second_anchor_withdraws`, `missing_third_anchor_withdraws`, `only_activation_recovers` | Actual trust-set inclusion is compared with model vectors; synthetic profile/sink rejection tests remove a domain or one of its anchors, and test recovery and added trust. |
| An outage deadline is bounded by certificate expiry and outage start plus `max_stale`; retry cannot extend it. | `outage_bounded_by_certificate`, `outage_bounded_by_freshness`, `retry_cannot_extend_deadline` | `retention_deadline` and `apply_outage` are compared with model vectors; integration tests cover stalled connections, RPC openings and rejected candidates. |
| Effective expiry is the earlier retained deadline or certificate expiry; status is expired at equality. | `effective_bounded_by_certificate`, `effective_bounded_by_retention`, `expired_is_not_usable`, `status_expired_at_retention`, `status_expired_at_certificate` | `bounded_deadline` and `SourceStatus::credential_status` are compared with model vectors, plus exact-boundary Rust tests. |

`SpiffePolicy.lean` proves these statements for an abstract state machine and
nonnegative integer time. It emits 473 finite cases. The Rust correspondence
test checks nine named SDK-error categories, 64 combinations of old and new
trust across three anchors in two domains, and sampled deadline, retry and
status boundaries. The fake Workload API tests are also run by `verify.sh`.
They test the real SDK's error mapping through gRPC, not just manually created
SDK errors. The suite records a fingerprint of the resolved dependency graph
rooted at `opensesame-spiffe-source`, alongside reviewed source hashes. A fake
Workload API test also exercises withdrawal and recovery through the production
`TransportGenerationsSink` and checks the resulting manager state.

Run `bash spec/formal/spiffe/verify.sh` from the repository root after installing
Lean as pinned by `lean-toolchain` and the repository's Rust toolchain. Set
`OPENSESAME_LEAN_BIN` to an absolute path if Lean is not on `PATH`. The shared
checker verifies the independent required theorem signatures, rejects warnings
and unapproved axioms, and supplies the vectors to the Rust test.

The pre-push selector also compares the resolved `Cargo.lock` graph rooted at
`opensesame-spiffe-source` across the commits being pushed. A change in that
closure selects this suite; a change confined to unrelated packages does not.
The graph conservatively includes dependencies in the lockfile even when they
are inactive for a particular feature, target, or build. It does not replace
review of manifests, Cargo configuration, or other build inputs. The drift check
compares the same full graph fingerprint whenever the suite runs. Never update
reviewed hashes or projection values without reviewing the implementation-to-model
boundary and rerunning the suite.

These checks do not prove that the SDK parses or authenticates every possible
Workload API response, that arbitrary Rust execution refines the Lean machine,
or that concurrent scheduling meets a hard real-time bound. The public source
API does not quarantine a pre-populated sink before its first activation; an
initial denial or outage can leave that previous generation in place. The
current gateway starts with an empty manager and waits for a source generation
before binding its listener. This suite does not prove that startup precondition
or listener and request-guard enforcement. The sink's prompt
withdrawal claim assumes stable wall time while a relative sleep is armed and
that the source task is scheduled in time. A forward wall-clock jump across a
deadline can delay sink withdrawal; status checks the supplied current time but
the sink is not proven to enforce the source deadline at every use. The finite
time cases do not cover Rust clock/duration overflow. The model does not verify
certificate signatures, trust bundles, endpoints, sink internals, or real SPIRE
behavior. The separately gated real-SPIRE reference test is not evidence of
interoperability unless executed.
