#!/usr/bin/env bash
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
python3 spec/formal/source-lifetime/check-drift.py
required="lean_vectors_match_source_owned_generation_manager"
OPENSESAME_SOURCE_LIFETIME_VECTORS="$scratch/vectors" \
  cargo test --locked -p opensesame-transport-security --all-features \
  --test source_lifetime_formal "$required" -- --ignored --exact | tee "$scratch/correspondence"
if [[ "$(grep -Fxc "test $required ... ok" "$scratch/correspondence" || true)" != 1 ]] ||
   ! grep -Eq '^test result: ok\. 1 passed; 0 failed; 0 ignored;' "$scratch/correspondence"; then
  echo "source-lifetime-formal: required Lean correspondence test did not run and pass" >&2
  exit 1
fi
cargo test --locked -p opensesame-transport-security --all-features \
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
  handshake_started_before_expiry_is_rechecked_after_tls_completes; do
  if [[ "$(grep -Fxc "test $name ... ok" "$scratch/manager" || true)" != 1 ]]; then
    echo "source-lifetime-formal: required manager test did not run and pass: $name" >&2
    exit 1
  fi
done
cargo test --locked -p opensesame-transport-security --all-features \
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
cargo test --locked -p opensesame-spiffe-source --all-features \
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
cargo test --locked -p opensesame-transport-security --all-features \
  --test source_lifetime_edges | tee "$scratch/edges"
for name in \
  source_profiles_reject_mismatched_labels_and_removed_domains_cannot_return \
  tls_only_keepalive_cannot_resume_after_source_handoff; do
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
  cargo test --locked -p opensesame-gateway --lib "$name" -- --exact | tee "$scratch/gateway"
  if [[ "$(grep -Fxc "test $name ... ok" "$scratch/gateway" || true)" != 1 ]]; then
    echo "source-lifetime-formal: required gateway test did not run and pass: $name" >&2
    exit 1
  fi
done
python3 spec/formal/source-lifetime/check-drift.py
