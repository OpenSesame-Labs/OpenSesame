#!/usr/bin/env bash
# Verify the history model and its named implementation correspondence tests.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
if [[ "${1:-}" == "--model-only" && "$#" == 1 ]]; then
  lean_bin="${OPENSESAME_LEAN_BIN:-lean}"
  if [[ "$(<"$root/spec/formal/source-trust-history/lean-toolchain")" != "leanprover/lean4:v4.24.0" ]] ||
     ! command -v "$lean_bin" >/dev/null 2>&1 ||
     [[ "$("$lean_bin" --version)" != "Lean (version 4.24.0,"* ]]; then
    echo "source-trust-history: pinned Lean 4.24.0 is required" >&2
    exit 1
  fi
  bash "$root/spec/formal/check-axioms.sh" "$lean_bin" \
    "$root/spec/formal/source-trust-history/SourceTrustHistory.lean"
  exit 0
fi
if [[ "$#" != 0 ]]; then
  echo "source-trust-history: unsupported runner arguments" >&2
  exit 1
fi
scratch="$(mktemp -d "${TMPDIR:-/tmp}/opensesame-source-history.XXXXXXXX")"
trap 'rm -rf "$scratch"' EXIT
cd "$root"
python3 -I spec/formal/source-trust-history/check-drift.py
export RUSTC_WRAPPER=""
unset OPENSESAME_FORMAL_RUSTC_LOG
export RUSTC_WORKSPACE_WRAPPER="$(python3 -I scripts/security/formal-cargo-isolation.py "$root")"
python3 -I scripts/security/formal-cargo-freshness.py init \
  --repo "$root" --manifest "$root/Cargo.toml" --state "$scratch/cargo-state.json" \
  --package opensesame-transport-security --package opensesame-spiffe-source \
  --package opensesame-gateway --package opensesame-cli
formal_cargo() {
  python3 -I "$root/scripts/security/formal-cargo-freshness.py" run \
    --state "$scratch/cargo-state.json" \
    --input-check "$root/spec/formal/source-trust-history/check-drift.py" -- "$@"
}
bash spec/formal/source-trust-history/verify.sh --model-only > "$scratch/vectors"
if [[ "$(grep -c '^case' "$scratch/vectors")" != 9 ]] ||
   [[ "$(grep -c '^stream' "$scratch/vectors")" != 2 ]] ||
   [[ "$(grep -c '^coord' "$scratch/vectors")" != 4 ]] ||
   [[ "$(grep -c '^file' "$scratch/vectors")" != 2 ]] ||
   [[ "$(grep -c '^lifecycle' "$scratch/vectors")" != 4 ]]; then
  echo "source-trust-history: the expected model vectors were not emitted" >&2
  exit 1
fi
export OPENSESAME_SOURCE_HISTORY_VECTORS="$scratch/vectors"
formal_cargo test --locked -p opensesame-gateway --lib \
    transport::source_history::tests -- --include-ignored | tee "$scratch/tests"
for name in \
  missing_requires_one_explicit_attestation_and_never_overwrites \
  rejects_untrusted_attestations_without_creating_a_row \
  refuses_memory_or_unsafe_sqlite_durability_settings \
  temp_shadow_cannot_divert_reads_or_conditional_writes_from_main \
  sqlite_restart_keeps_the_union_after_a_write_before_activation \
  contended_writers_retry_from_the_winning_union \
  corrupt_missing_and_oversized_rows_are_not_empty_history \
  removed_row_during_unchanged_union_is_not_acknowledged \
  quota_and_invalid_names_do_not_change_existing_history \
  lean_vectors_match_durable_history_store; do
  if [[ "$(grep -Fxc "test transport::source_history::tests::$name ... ok" "$scratch/tests" || true)" != 1 ]]; then
    echo "source-trust-history: required test did not run and pass: $name" >&2
    exit 1
  fi
done

check_tests() {
  local result="$1"
  shift
  for name in "$@"; do
    if [[ "$(grep -Fxc "test $name ... ok" "$result" || true)" != 1 ]]; then
      echo "source-trust-history: required test did not run and pass: $name" >&2
      exit 1
    fi
  done
}

formal_cargo test --locked -p opensesame-gateway --lib \
  transport::source_history::file_lock::tests -- --include-ignored | tee "$scratch/file-lease"
check_tests "$scratch/file-lease" \
  transport::source_history::file_lock::tests::memory_is_allowed_only_when_requested_and_unsafe_urls_fail_closed \
  transport::source_history::file_lock::tests::missing_database_is_not_created_for_offline_initialization \
  transport::source_history::file_lock::tests::repeated_and_aliased_claims_are_refused_for_the_process_lifetime \
  transport::source_history::file_lock::tests::lean_vectors_match_file_lease_claims

formal_cargo test --locked -p opensesame-transport-security --all-features --lib \
  generations::source_lifetime::source_history_activation::tests | tee "$scratch/provisional"
check_tests "$scratch/provisional" \
  generations::source_lifetime::source_history_activation::tests::a_paused_publication_keeps_the_wait_bound_until_owner_finalization

formal_cargo test --locked -p opensesame-transport-security --all-features \
  --test source_history_reservation | tee "$scratch/manager"
check_tests "$scratch/manager" \
  seeded_history_blocks_old_source_names_without_blocking_unrelated_local_trust \
  seed_refuses_existing_collisions_and_generation_races \
  source_claim_preserves_seeded_history_and_can_authoritatively_replace_it \
  source_publication_refuses_elapsed_wait_bounds_and_stale_epochs \
  pending_names_survive_same_manager_owner_handoff \
  pending_source_name_withdraws_colliding_local_trust_before_storage \
  independent_tightening_cannot_be_undone_by_source_finalization

formal_cargo test --locked -p opensesame-spiffe-source --all-features --lib \
  sink::transport::tests | tee "$scratch/finalization"
check_tests "$scratch/finalization" \
  sink::transport::tests::failed_finalization_with_no_previous_active_generation_withdraws_the_provisional_epoch

formal_cargo test --locked -p opensesame-spiffe-source --all-features \
  --test durable_history_policy | tee "$scratch/source"
check_tests "$scratch/source" \
  initial_source_is_not_published_before_history_acknowledges \
  reduced_snapshot_withdraws_before_history_wait_and_stop_remains_prompt \
  additive_wait_keeps_old_trust_only_until_its_observed_bound \
  zero_staleness_withdraws_the_old_generation_but_can_publish_a_fresh_one \
  dropping_old_owner_during_a_write_cannot_replace_its_successor \
  incoming_source_name_withdraws_a_colliding_local_bundle_before_the_write

formal_cargo test --locked -p opensesame-spiffe-source --all-features \
  --test durable_history_supersession -- --include-ignored | tee "$scratch/supersession"
check_tests "$scratch/supersession" \
  lean_vectors_match_observed_stream_supersession \
  observed_denial_withdraws_before_the_superseded_write_finishes \
  observed_reduction_supersedes_pending_addition_and_old_result_cannot_publish \
  saturated_history_refuses_new_snapshot_and_withdraws_immediately \
  cleared_history_failure_recovers_without_a_new_snapshot

formal_cargo test --locked -p opensesame-gateway --lib \
  transport::source_history::coordinator::tests -- --include-ignored | tee "$scratch/coordinator"
check_tests "$scratch/coordinator" \
  transport::source_history::coordinator::tests::duplicate_host_claim_preserves_the_sqlite_write_lock \
  transport::source_history::coordinator::tests::lean_vectors_match_real_owner_and_pending_write_guards \
  transport::source_history::coordinator::tests::successor_waits_until_a_detached_write_has_a_known_outcome \
  transport::source_history::coordinator::tests::dropping_an_unresolved_write_poison_fences_the_next_owner \
  transport::source_history::coordinator::tests::explicit_initialization_and_recovery_both_require_an_owner_lease \
  transport::source_history::coordinator::tests::every_manager_arc_keeps_the_exclusive_owner_slot \
  transport::source_history::coordinator::tests::aborted_worker_after_real_sqlite_commit_poison_fences_reconstruction \
  transport::source_history::coordinator::tests::dropping_returned_write_keeps_owner_until_real_sqlite_work_finishes \
  transport::source_history::coordinator::tests::saturated_detached_writes_refuse_new_work_before_spawning \
  transport::source_history::coordinator::tests::runtime_shutdown_poison_fences_an_unresolved_worker

formal_cargo test --locked -p opensesame-gateway --lib \
  transport::source_history::coordinator::integration_tests | tee "$scratch/sqlite-source"
check_tests "$scratch/sqlite-source" \
  transport::source_history::coordinator::integration_tests::committed_unpublished_name_survives_same_manager_owner_handoff \
  transport::source_history::coordinator::integration_tests::initialized_host_retains_source_names_across_restart_and_pem_transition \
  transport::source_history::coordinator::integration_tests::attested_history_blocks_pem_collision_after_reopen

formal_cargo test --locked -p opensesame-gateway --lib \
  transport::config_tests | tee "$scratch/host-config"
check_tests "$scratch/host-config" \
  transport::config_tests::unreadable_material_fails_the_runtime_build \
  transport::config_tests::a_managed_identity_with_no_custody_bridge_fails_the_build \
  transport::config_tests::nothing_configured_builds_no_runtime \
  transport::config_tests::an_unparseable_bindings_file_fails_the_runtime_build

formal_cargo test --locked -p opensesame-cli --bin opensesame \
  serve::tests | tee "$scratch/operator"
check_tests "$scratch/operator" \
  serve::tests::offline_attestation_handles_fresh_and_legacy_databases_once \
  serve::tests::oversized_attestation_does_not_write_a_history

formal_cargo test --locked -p opensesame-cli --test host_startup_security \
  configured_host_requires_offline_attestation_before_it_serves -- --exact | tee "$scratch/host-process"
check_tests "$scratch/host-process" \
  configured_host_requires_offline_attestation_before_it_serves

formal_cargo test --locked -p opensesame-gateway --lib \
  transport_lifecycle::trust_generation_tests::history_tests -- --include-ignored | tee "$scratch/trust"
check_tests "$scratch/trust" \
  transport_lifecycle::trust_generation_tests::history_tests::lean_vectors_match_stored_trust_adoption_and_rotation \
  transport_lifecycle::trust_generation_tests::history_tests::colliding_stored_name_is_quarantined_without_hiding_unrelated_trust \
  transport_lifecycle::trust_generation_tests::history_tests::source_rotation_reconciles_unrelated_trust_without_a_stored_revision_change \
  transport_lifecycle::trust_generation_tests::history_tests::generation_notification_reconciles_without_waiting_for_the_periodic_tick \
  transport_lifecycle::trust_generation_tests::history_tests::rotation_after_swap_before_epoch_record_keeps_the_exact_installed_generation

formal_cargo test --locked -p opensesame-gateway --lib \
  transport_lifecycle::routes_tests::trust_status_reports_quarantine_and_a_changed_serving_generation \
  -- --exact | tee "$scratch/trust-status"
check_tests "$scratch/trust-status" \
  transport_lifecycle::routes_tests::trust_status_reports_quarantine_and_a_changed_serving_generation

formal_cargo test --locked -p opensesame-gateway --lib \
  transport_lifecycle::routes_tests::empty_trust_reports_reconciled_for_a_live_manager \
  -- --exact | tee "$scratch/empty-status"
check_tests "$scratch/empty-status" \
  transport_lifecycle::routes_tests::empty_trust_reports_reconciled_for_a_live_manager

formal_cargo test --locked -p opensesame-gateway --lib \
  transport_lifecycle::trust_generation_tests::a_candidate_built_from_an_older_generation_is_refused \
  -- --exact | tee "$scratch/stale-merge"
check_tests "$scratch/stale-merge" \
  transport_lifecycle::trust_generation_tests::a_candidate_built_from_an_older_generation_is_refused
