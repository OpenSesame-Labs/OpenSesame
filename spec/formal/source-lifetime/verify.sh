#!/usr/bin/env bash
# Builds through the formal-cargo freshness session, like the other Rust
# suites: the vendored sqlx-sqlite path patch is declared with
# --reviewed-patch (the init refused undeclared patches when this gate fell
# back to plain cargo in e1142ec99), and check-drift.py executes the reviewed
# vendored-crate verifier on every input check.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
lean_bin="${OPENSESAME_LEAN_BIN:-lean}"
if ! command -v "$lean_bin" >/dev/null 2>&1 || [[ "$("$lean_bin" --version)" != "Lean (version 4.24.0,"* ]]; then
  echo "source-lifetime-formal: Lean 4.24.0 is required" >&2
  exit 1
fi
scratch="$(mktemp -d "${TMPDIR:-/tmp}/opensesame-source-lifetime.XXXXXXXX")"
trap 'rm -rf "$scratch"' EXIT
cd "$root/spec/formal/source-lifetime"
bash "$root/spec/formal/check-axioms.sh" "$lean_bin" "$root/spec/formal/source-lifetime/SourceLifetime.lean" > "$scratch/vectors"
cd "$root"
python3 -I spec/formal/source-lifetime/check-drift.py
export RUSTC_WRAPPER=""
unset OPENSESAME_FORMAL_RUSTC_LOG
export RUSTC_WORKSPACE_WRAPPER="$(python3 -I scripts/security/formal-cargo-isolation.py "$root")"
python3 -I scripts/security/formal-cargo-freshness.py init \
  --repo "$root" --manifest "$root/Cargo.toml" --state "$scratch/cargo-state.json" \
  --package opensesame-transport-security --package opensesame-spiffe-source \
  --package opensesame-gateway \
  --reviewed-patch sqlx-sqlite=patches/vendor/sqlx-sqlite-0.9.0
formal_cargo() {
  python3 -I "$root/scripts/security/formal-cargo-freshness.py" run \
    --state "$scratch/cargo-state.json" --input-check "$root/spec/formal/source-lifetime/check-drift.py" -- "$@"
}
required="lean_vectors_match_source_owned_generation_manager"
OPENSESAME_SOURCE_LIFETIME_VECTORS="$scratch/vectors" \
  formal_cargo test --locked -p opensesame-transport-security --all-features \
  --test source_lifetime_formal "$required" -- --ignored --exact | tee "$scratch/correspondence"
if [[ "$(grep -Fxc "test $required ... ok" "$scratch/correspondence" || true)" != 1 ]] ||
   ! grep -Eq '^test result: ok\. 1 passed; 0 failed; 0 ignored;' "$scratch/correspondence"; then
  echo "source-lifetime-formal: required Lean correspondence test did not run and pass" >&2
  exit 1
fi
signer="signing_fence::tests::lean_vectors_match_generation_bound_signer"
OPENSESAME_SOURCE_LIFETIME_VECTORS="$scratch/vectors" \
  formal_cargo test --locked -p opensesame-transport-security --all-features \
  --lib "$signer" -- --ignored --exact | tee "$scratch/signer-correspondence"
if [[ "$(grep -Fxc "test $signer ... ok" "$scratch/signer-correspondence" || true)" != 1 ]] ||
   ! grep -Eq '^test result: ok\. 1 passed; 0 failed; 0 ignored;' "$scratch/signer-correspondence"; then
  echo "source-lifetime-formal: required Lean signer correspondence did not run and pass" >&2
  exit 1
fi
formal_cargo test --locked -p opensesame-transport-security --all-features \
  --lib signing_fence::tests | tee "$scratch/signer"
for name in \
  expiry_before_signing_never_calls_the_private_key \
  a_delayed_signature_is_withheld_if_expiry_or_rotation_occurs \
  a_live_signature_is_returned_and_a_dropped_manager_fails_closed \
  a_preclaim_session_cache_cannot_return_secrets_after_claim \
  delayed_session_retrieval_withholds_secrets_after_source_claim; do
  if [[ "$(grep -Fxc "test signing_fence::tests::$name ... ok" "$scratch/signer" || true)" != 1 ]]; then
    echo "source-lifetime-formal: required signer test did not run and pass: $name" >&2
    exit 1
  fi
done
formal_cargo test --locked -p opensesame-transport-security --all-features \
  --test signing_fence_races | tee "$scratch/signing-races"
if [[ "$(grep -Fxc "test source_claim_after_session_retrieval_is_rejected_before_application_admission ... ok" "$scratch/signing-races" || true)" != 1 ]]; then
  echo "source-lifetime-formal: required post-retrieval race test did not run and pass" >&2
  exit 1
fi
formal_cargo test --locked -p opensesame-transport-security --all-features \
  --test source_lifetime_tls12 | tee "$scratch/tls12"
for name in \
  source_tls12_listener_never_resumes \
  tls12_session_prepared_before_claim_cannot_resume_after_claim; do
  if [[ "$(grep -Fxc "test $name ... ok" "$scratch/tls12" || true)" != 1 ]]; then
    echo "source-lifetime-formal: required TLS 1.2 test did not run and pass: $name" >&2
    exit 1
  fi
done
formal_cargo test --locked -p opensesame-transport-security --all-features \
  --test source_lifetime | tee "$scratch/manager"
for name in \
  claiming_quarantines_a_populated_manager_until_an_owned_activation \
  expiry_is_inclusive_latched_and_reset_only_by_a_fresh_source_activation \
  ordinary_updates_cannot_shadow_or_remove_source_owned_trust \
  owner_handoff_invalidates_old_owners_and_unrelated_managers \
  concurrent_old_tightening_cannot_expire_a_new_source_epoch \
  source_epoch_survives_trust_updates_and_delayed_events_cannot_change_a_new_epoch \
  source_claim_quarantines_existing_connections_before_any_snapshot \
  an_expired_source_blocks_new_handshakes_and_existing_requests \
  handshake_started_before_expiry_cannot_sign_after_expiry; do
  if [[ "$(grep -Fxc "test $name ... ok" "$scratch/manager" || true)" != 1 ]]; then
    echo "source-lifetime-formal: required manager test did not run and pass: $name" >&2
    exit 1
  fi
done
formal_cargo test --locked -p opensesame-transport-security --all-features \
  --lib generations::source_lifetime::tests | tee "$scratch/clock"
for name in \
  use_time_is_sampled_after_waiting_for_the_activation_lock \
  monotonic_deadline_refuses_a_rollback_before_first_observation \
  monotonic_outage_bound_survives_rollback_before_tightening; do
  if [[ "$(grep -Fxc "test generations::source_lifetime::tests::$name ... ok" "$scratch/clock" || true)" != 1 ]]; then
    echo "source-lifetime-formal: required clock test did not run and pass: $name" >&2
    exit 1
  fi
done
formal_cargo test --locked -p opensesame-spiffe-source --all-features \
  --lib source::lease_tests | tee "$scratch/source"
for name in \
  initial_denial_quarantines_a_populated_sink_then_valid_material_recovers \
  stalled_initial_rpc_and_competing_source_cannot_restore_the_old_sink \
  dropping_handle_quarantines_before_the_task_can_be_scheduled \
  an_outage_publishes_the_use_time_bound_before_its_timer_expires; do
  if [[ "$(grep -Fxc "test source::lease_tests::$name ... ok" "$scratch/source" || true)" != 1 ]]; then
    echo "source-lifetime-formal: required SPIFFE source test did not run and pass: $name" >&2
    exit 1
  fi
done
formal_cargo test --locked -p opensesame-transport-security --all-features \
  --test source_lifetime_edges | tee "$scratch/edges"
for name in \
  source_profiles_reject_mismatched_labels_and_removed_domains_cannot_return \
  tls_only_keepalive_cannot_resume_after_source_handoff \
  source_tls_only_listener_disables_ticket_resumption \
  source_listener_refuses_a_profile_that_substitutes_its_identity \
  ordinary_tls_resumes_but_a_prepared_connection_cannot_resume_after_source_claim; do
  if [[ "$(grep -Fxc "test $name ... ok" "$scratch/edges" || true)" != 1 ]]; then
    echo "source-lifetime-formal: required trust or TLS test did not run and pass: $name" >&2
    exit 1
  fi
done
for name in \
  transport_lifecycle::trust_generation_tests::source_tests::source_collision_can_be_removed_without_shadowing_federated_trust \
  transport::status::tests::quarantine_and_expiry_are_unloaded_with_revocation_precedence \
  transport::admission_tests::source_tests::expired_source_is_refused_at_service_admission \
  routes::est_server::tests::certificate_proof::freshness::certificate_inventory_rotation_after_await_refuses_the_original_peer \
  routes::est_server::tests::certificate_proof::freshness::password_budget_rotation_after_await_refuses_old_tls_provenance; do
  formal_cargo test --locked -p opensesame-gateway --lib "$name" -- --exact | tee "$scratch/gateway"
  if [[ "$(grep -Fxc "test $name ... ok" "$scratch/gateway" || true)" != 1 ]]; then
    echo "source-lifetime-formal: required gateway test did not run and pass: $name" >&2
    exit 1
  fi
done
python3 -I spec/formal/source-lifetime/check-drift.py
