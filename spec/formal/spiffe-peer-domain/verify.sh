#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
lean_bin="${OPENSESAME_LEAN_BIN:-lean}"
if ! command -v "$lean_bin" >/dev/null 2>&1 || [[ "$("$lean_bin" --version)" != "Lean (version 4.24.0,"* ]]; then
  echo "spiffe-peer-domain-formal: Lean 4.24.0 is required" >&2
  exit 1
fi
scratch="$(mktemp -d "${TMPDIR:-/tmp}/opensesame-peer-domain.XXXXXXXX")"
trap 'rm -rf "$scratch"' EXIT
cd "$root"
# Reviewed code and build inputs must be checked before Cargo executes.
python3 -I spec/formal/spiffe-peer-domain/check-drift.py
export RUSTC_WRAPPER=""
unset OPENSESAME_FORMAL_RUSTC_LOG
export RUSTC_WORKSPACE_WRAPPER="$(python3 -I scripts/security/formal-cargo-isolation.py "$root")"
python3 -I scripts/security/formal-cargo-freshness.py init \
  --repo "$root" --manifest "$root/Cargo.toml" --state "$scratch/cargo-state.json" \
  --package opensesame-domain --package opensesame-transport-security --package opensesame-ingress-evidence --package opensesame-spiffe-source --package opensesame-gateway \
  --reviewed-patch sqlx-sqlite=patches/vendor/sqlx-sqlite-0.9.0
formal_cargo() {
  python3 -I "$root/scripts/security/formal-cargo-freshness.py" run \
    --state "$scratch/cargo-state.json" --input-check "$root/spec/formal/spiffe-peer-domain/check-drift.py" -- "$@"
}
bash spec/formal/check-axioms.sh "$lean_bin" \
  "$root/spec/formal/spiffe-peer-domain/SpiffePeerDomain.lean" > "$scratch/vectors"
export CARGO_INCREMENTAL=0
require_one() {
  local name="$1"
  shift
  "$@" | tee "$scratch/test"
  if [[ "$(grep -Fxc "test $name ... ok" "$scratch/test" || true)" != 1 ]] ||
     ! grep -Eq '^test result: ok\. 1 passed; 0 failed; 0 ignored;' "$scratch/test"; then
    echo "spiffe-peer-domain-formal: required test $name did not run and pass" >&2
    exit 1
  fi
}
formal="transport::spiffe_domain_formal_tests::lean_vectors_match_real_spiffe_service_admission"
export OPENSESAME_SPIFFE_PEER_VECTORS="$scratch/vectors"
require_one "$formal" formal_cargo test --locked -p opensesame-domain --lib "$formal" -- --ignored --exact
for name in \
  transport::spiffe_attest_tests::spiffe_evidence_uses_only_exact_id_but_still_checks_leaf_revocation \
  transport::spiffe_attest_tests::forwarding_keeps_the_ingress_selectors_restricted \
  transport::spiffe_attest_tests::preserved_ingress_cannot_be_substituted_into_direct_evidence \
  transport::spiffe_attest_tests::direct_spiffe_constructor_refuses_a_raw_forwarded_ingress \
  transport::spiffe_attest_tests::generic_constructor_refuses_raw_forwarded_ingress; do
  require_one "$name" formal_cargo test --locked -p opensesame-domain --lib "$name" -- --exact
done
for name in \
  spiffe_domain_metadata_is_explicit_and_canonical \
  source_domain_is_checked_before_exact_spiffe_peer_evidence \
  live_tls_spiffe_identity_is_required_for_service_admission \
  private_root_evidence_retains_dns_and_thumbprint_selectors; do
  require_one "$name" formal_cargo test --locked -p opensesame-transport-security --all-features --test spiffe_peer_domain "$name" -- --exact
done
name=spiffe_domain_rotation_requires_fresh_client_authentication
require_one "$name" formal_cargo test --locked -p opensesame-transport-security --all-features --test spiffe_peer_rotation "$name" -- --exact
name=ordinary_activation_cannot_relabel_a_source_owned_spiffe_domain
require_one "$name" formal_cargo test --locked -p opensesame-transport-security --all-features --test source_lifetime_edges "$name" -- --exact
for name in outbound_spiffe_reference_must_belong_to_explicit_bundle_domain spiffe_dual_eku_leaf_is_accepted_under_the_spiffe_profile spiffe_mismatches_are_denied; do
  require_one "$name" formal_cargo test --locked -p opensesame-transport-security --all-features --test servername "$name" -- --exact
done
for name in spiffe_forwarding_preserves_ingress_policy_and_checks_origin_domain spiffe_ingress_admission_checks_leaf_revocation_separately; do
  require_one "$name" formal_cargo test --locked -p opensesame-ingress-evidence --test verify "$name" -- --exact
done
name=a_revoked_originating_leaf_is_refused_before_the_handler
require_one "$name" formal_cargo test --locked -p opensesame-ingress-evidence --test revocation "$name" -- --exact
for name in \
  svid_profile::tests::conforming_svid_passes_for_both_roles_and_reports_facts \
  svid_profile::tests::at_spiffe_san_extra_uri_san_is_rejected \
  svid_profile::tests::at_spiffe_san_wrong_trust_domain_is_rejected_before_identity \
  svid_profile::tests::at_tls_purpose_key_usage_must_be_present_critical_and_digital_signature \
  svid_profile::tests::at_tls_purpose_eku_must_match_role_and_be_dual_when_present \
  svid_profile::tests::unknown_critical_extension_and_validity_window_are_enforced; do
  require_one "$name" formal_cargo test --locked -p opensesame-spiffe-source --all-features --lib "$name" -- --exact
done
name=removed_identity_withdraws_the_production_generation_and_can_recover
require_one "$name" formal_cargo test --locked -p opensesame-spiffe-source --all-features --test production_sink_policy "$name" -- --exact
name=transport::boot::source_trust_tests::generic_source_owner_cannot_override_the_configured_trust_domain
require_one "$name" formal_cargo test --locked -p opensesame-gateway --lib "$name" -- --exact
name=transport_lifecycle::trust_tests::stored_spiffe_profile_keeps_its_explicit_canonical_domain
require_one "$name" formal_cargo test --locked -p opensesame-gateway --lib "$name" -- --exact
python3 -I spec/formal/spiffe-peer-domain/check-drift.py
