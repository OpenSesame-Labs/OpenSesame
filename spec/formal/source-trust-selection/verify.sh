#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--nats" ) ]]; then
  echo "usage: $0 [--nats]" >&2
  exit 2
fi
lean_bin="${OPENSESAME_LEAN_BIN:-lean}"
if ! command -v "$lean_bin" >/dev/null 2>&1 || [[ "$("$lean_bin" --version)" != "Lean (version 4.24.0,"* ]]; then
  echo "source-trust-selection-formal: Lean 4.24.0 is required" >&2
  exit 1
fi
scratch="$(mktemp -d "${TMPDIR:-/tmp}/opensesame-source-selection.XXXXXXXX")"
trap 'rm -rf "$scratch"' EXIT
cd "$root"
if [[ "${1:-}" == "--nats" ]]; then
  export OPENSESAME_FORMAL_NATS=1
  python3 -I spec/formal/source-trust-selection/check-drift.py --nats
  OPENSESAME_NATS_VECTOR_MODE=source bash spec/formal/check-axioms.sh "$lean_bin" \
    "$root/spec/formal/source-trust-selection/SourceTrustSelection.lean" > "$scratch/vectors"
  OPENSESAME_NATS_VECTOR_MODE=client-svid bash spec/formal/check-axioms.sh "$lean_bin" \
    "$root/spec/formal/source-trust-selection/SourceTrustSelection.lean" > "$scratch/client-vectors"
  OPENSESAME_NATS_VECTOR_MODE=handshake-fence bash spec/formal/check-axioms.sh "$lean_bin" \
    "$root/spec/formal/source-trust-selection/SourceTrustSelection.lean" > "$scratch/handshake-vectors"
  OPENSESAME_NATS_VECTOR_MODE=retry-limit bash spec/formal/check-axioms.sh "$lean_bin" \
    "$root/spec/formal/source-trust-selection/SourceTrustSelection.lean" > "$scratch/retry-vectors"
  if ! bash scripts/mtls/mtls-fixtures.sh verify nats-server >/dev/null; then
    echo "nats-trust-formal: install the pinned fixture separately: bash scripts/mtls/mtls-fixtures.sh fetch nats-server" >&2
    exit 1
  fi
  fixture="$(bash scripts/mtls/mtls-fixtures.sh list | awk -F '\t' '$1 == "nats-server" { print $3 }')"
  if [[ -z "$fixture" || ! -x "$fixture" ]]; then
    echo "nats-trust-formal: verified NATS fixture path is unavailable" >&2
    exit 1
  fi
  fixture="$(cd "$(dirname "$fixture")" && pwd -P)/$(basename "$fixture")"
  export RUSTC_WRAPPER=""
  unset OPENSESAME_FORMAL_RUSTC_LOG
  export RUSTC_WORKSPACE_WRAPPER="$(python3 -I scripts/security/formal-cargo-isolation.py "$root")"
  python3 -I scripts/security/formal-cargo-freshness.py init \
    --repo "$root" --manifest "$root/Cargo.toml" --state "$scratch/cargo-state.json" \
    --package opensesame-task-bus --package opensesame-transport-security \
    --reviewed-patch sqlx-sqlite=patches/vendor/sqlx-sqlite-0.9.0
  formal_cargo() {
    python3 -I "$root/scripts/security/formal-cargo-freshness.py" run \
      --state "$scratch/cargo-state.json" --input-check "$root/spec/formal/source-trust-selection/check-drift.py" -- "$@"
  }
  run_nats_test() {
    local name="$1" output="$2"
    shift 2
    OPENSESAME_SOURCE_SELECTION_VECTORS="$scratch/vectors" OPENSESAME_NATS_CLIENT_VECTORS="$scratch/client-vectors" \
      OPENSESAME_NATS_HANDSHAKE_VECTORS="$scratch/handshake-vectors" \
      OPENSESAME_NATS_RETRY_VECTORS="$scratch/retry-vectors" \
      OPENSESAME_MTLS_FIXTURES=1 OPENSESAME_MTLS_BIN_NATS_SERVER="$fixture" CARGO_INCREMENTAL=0 \
      formal_cargo test --locked -p opensesame-task-bus --features live-tests --lib "$name" -- "$@" --exact | tee "$scratch/$output"
    if [[ "$(grep -Fxc "test $name ... ok" "$scratch/$output" || true)" != 1 ]] ||
       ! grep -Eq '^test result: ok\. 1 passed; 0 failed; 0 ignored;' "$scratch/$output"; then
      echo "nats-trust-formal: required test $name did not run and pass" >&2
      exit 1
    fi
  }
  run_transport_test() {
    local name="$1" output="$2"
    CARGO_INCREMENTAL=0 formal_cargo test --locked -p opensesame-transport-security --lib "$name" -- --exact | tee "$scratch/$output"
    if [[ "$(grep -Fxc "test $name ... ok" "$scratch/$output" || true)" != 1 ]] ||
       ! grep -Eq '^test result: ok\. 1 passed; 0 failed; 0 ignored;' "$scratch/$output"; then
      echo "nats-trust-formal: required test $name did not run and pass" >&2
      exit 1
    fi
  }
  run_nats_test nats::live_mixed::lean_vectors_match_nats_injection correspondence --ignored
  run_nats_test nats::live_roles::injected_kind_and_identity_must_match_configured_policy identity
  run_nats_test nats::live_tests::injected_spiffe_client_matches_locator_and_profile client_svid --ignored
  run_nats_test nats::tests::security_bearing_env_settings_never_select_plaintext env
  run_nats_test nats_transport_env::tests::nonassertive_env_cannot_override_stored_tls nonassertive
  run_nats_test validate::tests::invalid_nats_security_booleans_fail_closed flags
  run_nats_test validate::tests::explicit_plaintext_flag_cannot_disable_security_settings explicit_false
  run_nats_test validate::tests::lean_vectors_match_nats_reconnect_limit retry_limit --ignored
  run_nats_test tests::contradictory_nats_security_sources_are_refused conflicts
  run_nats_test tests::mutated_public_policy_cannot_ignore_security_locators locators
  run_nats_test tests::stored_tls_requirements_cannot_resolve_to_plaintext stored
  run_nats_test tests::failed_and_old_connections_cannot_change_active_health health
  run_nats_test nats::rotation::tests::pending_old_session_drain_cannot_block_rotation drain
  run_nats_test nats::live_delivery::accepted_material_and_view_follow_serialized_rotations rotation --ignored
  run_nats_test nats::live_topology::injected_trust_enforces_configured_crls crls --ignored
  run_nats_test nats::live_routes::injected_sessions_fence_reconnect_and_rotation reconnect --ignored
  run_transport_test bounded::tests::single_handshake_gate_consumes_failed_and_concurrent_attempts single_handshake
  bash scripts/mtls/mtls-fixtures.sh verify nats-server >/dev/null
  python3 -I spec/formal/source-trust-selection/check-drift.py --nats
  exit 0
fi

export OPENSESAME_FORMAL_NATS=0
# Check reviewed source and optional build scripts before Cargo can execute.
python3 -I spec/formal/source-trust-selection/check-drift.py
export RUSTC_WRAPPER=""
unset OPENSESAME_FORMAL_RUSTC_LOG
export RUSTC_WORKSPACE_WRAPPER="$(python3 -I scripts/security/formal-cargo-isolation.py "$root")"
python3 -I scripts/security/formal-cargo-freshness.py init \
  --repo "$root" --manifest "$root/Cargo.toml" --state "$scratch/cargo-state.json" \
  --package opensesame-gateway \
  --reviewed-patch sqlx-sqlite=patches/vendor/sqlx-sqlite-0.9.0
formal_cargo() {
  python3 -I "$root/scripts/security/formal-cargo-freshness.py" run \
    --state "$scratch/cargo-state.json" --input-check "$root/spec/formal/source-trust-selection/check-drift.py" -- "$@"
}
OPENSESAME_NATS_VECTOR_MODE=source bash spec/formal/check-axioms.sh "$lean_bin" \
  "$root/spec/formal/source-trust-selection/SourceTrustSelection.lean" > "$scratch/vectors"
required="transport::boot::source_trust_selection::formal::lean_vectors_match_source_trust_selection"
OPENSESAME_SOURCE_SELECTION_VECTORS="$scratch/vectors" CARGO_INCREMENTAL=0 \
  formal_cargo test --locked -p opensesame-gateway --lib "$required" -- --ignored --exact | tee "$scratch/correspondence"
if [[ "$(grep -Fxc "test $required ... ok" "$scratch/correspondence" || true)" != 1 ]] ||
   ! grep -Eq '^test result: ok\. 1 passed; 0 failed; 0 ignored;' "$scratch/correspondence"; then
  echo "source-trust-selection-formal: required selector correspondence did not run and pass" >&2
  exit 1
fi
exact="transport::boot::source_trust_selection::formal::returns_exact_requested_source_bundle"
CARGO_INCREMENTAL=0 formal_cargo test --locked -p opensesame-gateway --lib "$exact" -- --exact | tee "$scratch/exact"
if [[ "$(grep -Fxc "test $exact ... ok" "$scratch/exact" || true)" != 1 ]] ||
   ! grep -Eq '^test result: ok\. 1 passed; 0 failed; 0 ignored;' "$scratch/exact"; then
  echo "source-trust-selection-formal: exact source bundle regression did not run and pass" >&2
  exit 1
fi
live="transport::boot::source_trust_tests::restart_cannot_use_a_stored_bundle_for_a_source_selected_domain"
CARGO_INCREMENTAL=0 formal_cargo test --locked -p opensesame-gateway --lib "$live" -- --exact | tee "$scratch/live"
if [[ "$(grep -Fxc "test $live ... ok" "$scratch/live" || true)" != 1 ]] ||
   ! grep -Eq '^test result: ok\. 1 passed; 0 failed; 0 ignored;' "$scratch/live"; then
  echo "source-trust-selection-formal: required source trust regression did not run and pass" >&2
  exit 1
fi
python3 -I spec/formal/source-trust-selection/check-drift.py
