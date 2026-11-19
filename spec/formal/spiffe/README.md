# SPIFFE withdrawal and outage policy

This suite records the decisions in
[`source.rs`](../../../crates/spiffe-source/src/source.rs),
[`source_policy.rs`](../../../crates/spiffe-source/src/source_policy.rs),
[`bundles.rs`](../../../crates/spiffe-source/src/bundles.rs),
[`outage.rs`](../../../crates/spiffe-source/src/outage.rs), and
[`status.rs`](../../../crates/spiffe-source/src/status.rs). The governing
contract is [ADR 0132 §12](../../../docs/adr/0132-optional-mtls-and-workload-identity.md),
as refined by [ADR 0227](../../../docs/adr/0227-spiffe-withdrawal-under-ambiguous-snapshots.md).

| Requirement | Lean theorem | Implementation evidence |
|---|---|---|
| No identity, an empty SVID list, an empty Workload API response (classified as that same empty-SVID decision), permission denial, authentication failure, a missing required bundle, or an unparseable snapshot withdraws the model state. Permission and authentication keep distinct decision names. | `no_identity_withdraws`, `permission_denial_withdraws`, `unauthenticated_withdraws`, `empty_snapshot_withdraws`, `missing_bundle_withdraws`, `malformed_snapshot_withdraws` | The actual SDK-error classifier is compared with model decisions. Fake Workload API tests exercise denial on opening and streaming, malformed unrelated SVIDs, and omission combined with malformed data. |
| `UNAVAILABLE`, EOF and other non-denial transport failures take the outage path. Empty responses and wrapped `PERMISSION_DENIED` statuses take the withdrawal path above. | `transient_transport_is_outage`, `outage_preserves_active` | Classifier vectors and synthetic reconnect tests. |
| A rejected parsed candidate retains an active model state when old trust remains present; each of the three modeled old anchors causes withdrawal if removed. Only activation recovers a withdrawn state. | `rejected_preserved_trust_keeps_active`, `missing_anchor_withdraws`, `missing_second_anchor_withdraws`, `missing_third_anchor_withdraws`, `only_activation_recovers` | Actual trust-set inclusion is compared with model vectors; synthetic profile/sink rejection tests remove a domain or one of its anchors, and test recovery and added trust. |
| An outage deadline is bounded by certificate expiry and outage start plus `max_stale`; retry cannot extend it. | `outage_bounded_by_certificate`, `outage_bounded_by_freshness`, `retry_cannot_extend_deadline` | `retention_deadline` and `apply_outage` are compared with model vectors; integration tests cover stalled connections, RPC openings and rejected candidates. |
| Effective expiry is the earlier retained deadline or certificate expiry; status is expired at equality. | `effective_bounded_by_certificate`, `effective_bounded_by_retention`, `expired_is_not_usable`, `status_expired_at_retention`, `status_expired_at_certificate` | `bounded_deadline` and `SourceStatus::credential_status` are compared with model vectors, plus exact-boundary Rust tests. |

`SpiffePolicy.lean` proves these statements for an abstract state machine and
nonnegative integer time. It emits 473 finite cases. The Rust correspondence
test checks nine named SDK-error categories, 64 combinations of old and new
trust across three anchors in two domains, and sampled deadline, retry and
status boundaries. The fake Workload API tests are also run by `verify.sh`.
They test the real SDK's error mapping through gRPC, not just manually created
SDK errors. The suite records a fingerprint of the full resolved dependency closure
rooted at `opensesame-spiffe-source` (no `--dependency` filter), alongside
reviewed source hashes bound to git blobs. A fake
Workload API test also exercises withdrawal and recovery through the production
`TransportGenerationsSink` and checks the resulting manager state.

Run `bash spec/formal/spiffe/verify.sh` from the repository root after installing
Lean as pinned by `lean-toolchain` and the repository's Rust toolchain. Set
`OPENSESAME_LEAN_BIN` to an absolute path if Lean is not on `PATH`. The shared
checker verifies the independent required theorem signatures, rejects warnings
and unapproved axioms, and supplies the vectors to the Rust test.

The drift check hashes that same full closure:

```sh
python3 scripts/security/cargo-lock-projection.py \
  --root opensesame-spiffe-source BEFORE.lock AFTER.lock
```

That is the graph `projection_sha256` records in `coverage.json`. The narrower
`--dependency spiffe` selection is a different closure and is not the gate.
The full closure includes `shuttle` through `opensesame-domain` when that edge
is present in `Cargo.lock`, including when `shuttle` is inactive for the
SPIFFE build. Such a lockfile change selects this suite; the lockfile alone
cannot tell an inactive edge from one the build uses. The fingerprint is a
conservative resolved closure, not an active build plan, feature set, or proof
of source integrity. Manifests, Cargo configuration, patches, and the toolchain
stay outside it. Limits are stated in
[`cargo-lock-projection.md`](../../../scripts/security/cargo-lock-projection.md).
Never update reviewed hashes, blob ids, or projection values without reviewing
the implementation-to-model boundary and rerunning the suite.

These checks do not prove that the SDK parses or authenticates every possible
Workload API response, that arbitrary Rust execution refines the Lean machine,
or that concurrent scheduling meets a hard real-time bound. The separate
[source-lifetime suite](../source-lifetime/README.md) covers selected source
ownership and post-handshake/request-admission decisions; its clock, TLS key-use,
caller-provenance, and restart assumptions apply here too. The finite time cases
do not cover Rust clock/duration overflow. This model does not verify certificate
signatures, trust bundles, endpoints, sink internals, or real SPIRE behavior.
The separately gated real-SPIRE reference test is not evidence of interoperability
unless executed.
