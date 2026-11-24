#!/usr/bin/env bash
# CLI-WA1–WA3, RELAY-T1 and RELAY-F1: Lean model, reviewed-source pins, and
# Lean-emitted vectors replayed against the real Rust code by Cargo tests.
# `--negative-controls` also mutates each key guard in place (restored on exit)
# and requires the named correspondence test to fail with a decision mismatch.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
lean_bin="${OPENSESAME_LEAN_BIN:-lean}"
fail() { echo "host-cli-formal: $*" >&2; exit 1; }
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--negative-controls" ) ]]; then
  echo "usage: $0 [--negative-controls]" >&2
  exit 2
fi
if ! command -v "$lean_bin" >/dev/null 2>&1 || [[ "$("$lean_bin" --version)" != "Lean (version 4.24.0,"* ]]; then
  fail "Lean 4.24.0 is required"
fi
rust_version="$(python3 -I -c 'import sys,tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["toolchain"]["channel"])' "$root/rust-toolchain.toml")"
[[ "$(rustc --version)" == "rustc $rust_version "* ]] || fail "expected rustc $rust_version"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/opensesame-host-cli.XXXXXXXX")"
restore() {
  if [[ -d "$scratch/backup" ]]; then (cd "$scratch/backup" && find . -type f -print0 | while IFS= read -r -d '' f; do cp "$f" "$root/$f"; done); fi
  rm -rf "$scratch"
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$root"
# Workspace artifacts in a shared CARGO_TARGET_DIR are keyed without the
# checkout path; a private wrapper namespace keeps another worktree's build
# from standing in for this one.
export RUSTC_WRAPPER=""
unset OPENSESAME_FORMAL_RUSTC_LOG
RUSTC_WORKSPACE_WRAPPER="$(python3 -I scripts/security/formal-cargo-isolation.py "$root")"
export RUSTC_WORKSPACE_WRAPPER

# Reviewed bytes of the modeled guards and of the correspondence harness. A
# change requires re-reviewing HostCli.lean against the source before re-pinning.
check_sources() {
  python3 -I -c '
import hashlib, sys
for line in sys.stdin.read().split("\n"):
    if not line.strip():
        continue
    digest, path = line.split("  ", 1)
    if hashlib.sha256(open(path, "rb").read()).hexdigest() != digest:
        sys.exit(f"host-cli-formal: source drift in {path}; review the model before re-pinning")
' <<'PINS'
753b611e24c402a3b4d3402434a1a1ff7fef637b64e39750ed7ad8d62d9dfb7e  crates/cli-app-integration/src/webauthn_assertion.rs
52fc030354b664b306ae90a9331e0e2a3d3f95349c06785e240e10bacc86e801  crates/cli-app-integration/src/pairing/binding.rs
52abfe1df124df53db7eaa762b3f5f3e41e98366ca313698ab22506dffbab5b2  crates/cli-app-integration/src/lib.rs
46735b8e86a5bbb71ef12d39836c23178debea32ac4080e3a62baca429f5f960  crates/cli-app-integration/src/human_proof.rs
e6b2410f2ec90c2b6fa02eda7b39ebcf7724e33944043be233dfef7024984f59  crates/cli-app-integration/src/policy.rs
52597bb564e14ddafdf1f0f78da7c00d076f027d3ef6149e3009e03c34200596  spec/conformance/cli-app-integration.json
e0ab1eca0c5c964a742c2702fffdae12a4bbee19af8f52846084a886077e8d77  crates/cli-app-integration/src/webauthn_high_risk_tests.rs
6cb35f7dcafc5bbe16ddd212af7ee455e6055c2e1ea9f34508550164d6a03a15  crates/cli-app-integration/src/webauthn_registration_tests.rs
c7ce2f3e4f7871a5dca53cb164caf1674a0f3a8c33198e7904f2fcf2abaf3109  crates/gateway/src/routes/relay.rs
40c47223331637a3daa748b570dba1d542a1c5e8c7a80a367a3c1928c3e350e9  crates/gateway/src/routes/relay_scope.rs
5face5b2853bd81e75c05bc61876f7239af4d58b218ce5f84d224861dd4ac81a  crates/gateway/src/routes/relay_tenant_tests.rs
232dc541888a8fc7da15a12ee59daf877060176b5d80b56b61ec8307fc353167  crates/gateway/src/routes/intents_queue.rs
a4785573bb48a517aea5304dc56ddcefae101876258165f70b9df745af8d3248  crates/gateway/src/routes/intents_relay_mode_tests.rs
8b9aec5002cc16f66c95627f8bcc58f515861f640b32a702dd15f5d382a4e19f  crates/connection-broker/src/delegation_mode.rs
53c1fa54f5982f79e571b71de05d0f96eb9df7fd01755a84654a931979a71c91  crates/connection-broker/src/delegation_lineage.rs
c24d89ba6687ed3ac31b793d12d38d983b994bd99313e44ef4052921eba7ad1d  crates/connection-broker/src/tests/delegation_mode_tests.rs
PINS
}
check_sources

bash spec/formal/check-axioms.sh "$lean_bin" "$root/spec/formal/host-cli/HostCli.lean" > "$scratch/vectors"
for expected in wa1:1224 wa2:384 wa2seq:512 wa3e:768 wa3p:192 relay:1512 mode:7; do
  family="${expected%%:*}"
  [[ "$(grep -c "^$family"$'\t' "$scratch/vectors" || true)" == "${expected#*:}" ]] ||
    fail "Lean emitted an unexpected number of $family vectors"
done
export OPENSESAME_HOST_CLI_VECTORS="$scratch/vectors"

cli=(webauthn_assertion::high_risk_tests::lean_assertion_vectors_match_verify_passkey_assertion
  webauthn_assertion::registration_tests::lean_registration_vectors_match_register_webauthn
  webauthn_assertion::registration_tests::lean_registration_histories_match_register_and_advance
  webauthn_assertion::high_risk_tests::lean_ensure_vectors_match_the_session_store
  webauthn_assertion::high_risk_tests::lean_human_proof_vectors_match_verification_and_approval)
gateway=(routes::relay::tests::tenant::lean_relay_vectors_match_the_relay_routes
  routes::intents::delegated_invoke_tests::relay_mode_tests::lean_mode_vectors_match_delegated_invocation)
broker=(tests::delegation_mode_tests::lean_mode_vectors_match_parse_claim_and_resolution)

# Run exactly the named ignored tests and require each to pass once.
require_all() {
  local package="$1" log="$2"
  shift 2
  cargo test --locked -p "$package" --lib -- --ignored --exact "$@" > "$log" 2>&1 || return 1
  local name
  for name in "$@"; do
    [[ "$(grep -Fxc "test $name ... ok" "$log" || true)" == 1 ]] || return 1
  done
  grep -Eq "^test result: ok\. $# passed; 0 failed; 0 ignored;" "$log"
}
run_suite() {
  require_all opensesame-cli-app-integration "$scratch/cli.log" "${cli[@]}" || { cat "$scratch/cli.log" >&2; fail "CLI correspondence failed"; }
  require_all opensesame-gateway "$scratch/gateway.log" "${gateway[@]}" || { cat "$scratch/gateway.log" >&2; fail "relay correspondence failed"; }
  require_all opensesame-connection-broker "$scratch/broker.log" "${broker[@]}" || { cat "$scratch/broker.log" >&2; fail "mode correspondence failed"; }
}
run_suite
# Existing behavior regressions for the same boundaries.
for spec in "opensesame-cli-app-integration webauthn_assertion::" "opensesame-cli-app-integration human_proof::" \
  "opensesame-gateway routes::relay::" "opensesame-gateway routes::intents::delegated_invoke_tests::relay_mode_tests::" \
  "opensesame-connection-broker tests::delegation_mode_tests::"; do
  read -r package filter <<< "$spec"
  cargo test --locked -p "$package" --lib "$filter" > "$scratch/regress.log" 2>&1 &&
    grep -Eq '^test result: ok\. [1-9][0-9]* passed; 0 failed;' "$scratch/regress.log" ||
    { cat "$scratch/regress.log" >&2; fail "regressions under $filter failed"; }
done
check_sources
echo "host-cli-formal: 22 obligations proved; 4599 Lean vectors match the Rust implementation"

[[ "${1:-}" == "--negative-controls" ]] || exit 0
# Runner controls: an empty vector file and a test that does not exist must fail.
: > "$scratch/empty"
OPENSESAME_HOST_CLI_VECTORS="$scratch/empty" require_all opensesame-cli-app-integration "$scratch/nc.log" "${cli[0]}" &&
  fail "an empty vector file was accepted"
require_all opensesame-cli-app-integration "$scratch/nc.log" "${cli[0]}_absent" && fail "a missing test was accepted"
mkdir -p "$scratch/backup"
while IFS=$'\t' read -r control package test file old new; do
  [[ -n "$control" ]] || continue
  [[ -f "$scratch/backup/$file" ]] || { mkdir -p "$(dirname "$scratch/backup/$file")"; cp "$file" "$scratch/backup/$file"; }
  python3 -I -c '
import sys
path, old, new = sys.argv[1], *(a.encode().decode("unicode_escape") for a in sys.argv[2:])
text = open(path).read()
if text.count(old) != 1:
    sys.exit(f"host-cli-formal: control target is not unique in {path}")
open(path, "w").write(text.replace(old, new, 1))
' "$file" "$old" "$new"
  if require_all "$package" "$scratch/nc.log" "$test"; then
    fail "negative control was not detected: $control"
  fi
  grep -q 'decision mismatch' "$scratch/nc.log" || { cat "$scratch/nc.log" >&2; fail "$control failed without a decision mismatch"; }
  cp "$scratch/backup/$file" "$file"
  echo "host-cli-formal: detected negative control $control"
done <<'CONTROLS'
wa1-uv-flag	opensesame-cli-app-integration	webauthn_assertion::high_risk_tests::lean_assertion_vectors_match_verify_passkey_assertion	crates/cli-app-integration/src/webauthn_assertion.rs	auth_data[32] & 0x05 == 0x05	auth_data[32] & 0x01 == 0x01
wa1-cross-origin	opensesame-cli-app-integration	webauthn_assertion::high_risk_tests::lean_assertion_vectors_match_verify_passkey_assertion	crates/cli-app-integration/src/webauthn_assertion.rs	|| client_data.cross_origin	|| false
wa1-top-origin	opensesame-cli-app-integration	webauthn_assertion::high_risk_tests::lean_assertion_vectors_match_verify_passkey_assertion	crates/cli-app-integration/src/webauthn_assertion.rs	is_some_and(|top| top != stored.origin.as_str())	is_some_and(|_| false)
wa1-rp-hash	opensesame-cli-app-integration	webauthn_assertion::high_risk_tests::lean_assertion_vectors_match_verify_passkey_assertion	crates/cli-app-integration/src/webauthn_assertion.rs	&auth_data[..32] == expected_rp_hash &&
wa1-counter	opensesame-cli-app-integration	webauthn_assertion::high_risk_tests::lean_assertion_vectors_match_verify_passkey_assertion	crates/cli-app-integration/src/webauthn_assertion.rs	new_count <= stored.sign_count	new_count < stored.sign_count
wa2-replace-id	opensesame-cli-app-integration	webauthn_assertion::registration_tests::lean_registration_vectors_match_register_webauthn	crates/cli-app-integration/src/pairing/binding.rs	existing.credential_id_b64 != credential_id_b64	false
wa2-rollback	opensesame-cli-app-integration	webauthn_assertion::registration_tests::lean_registration_histories_match_register_and_advance	crates/cli-app-integration/src/pairing/binding.rs	existing.sign_count.max(verified_sign_count)	verified_sign_count
wa3-ensure-pause	opensesame-cli-app-integration	webauthn_assertion::high_risk_tests::lean_ensure_vectors_match_the_session_store	crates/cli-app-integration/src/policy.rs	bool {\n    true\n}	bool {\n    false\n}
wa3-proof-pause	opensesame-cli-app-integration	webauthn_assertion::high_risk_tests::lean_human_proof_vectors_match_verification_and_approval	crates/cli-app-integration/src/human_proof.rs	if crate::is_approval_blocked(&ctx.verb)	if false
t1-get-tenant	opensesame-gateway	routes::relay::tests::tenant::lean_relay_vectors_match_the_relay_routes	crates/gateway/src/routes/relay.rs	WHERE id = ? AND organization_id = ?"	WHERE id = ? AND (organization_id = ? OR 1)"
t1-deny-holder	opensesame-gateway	routes::relay::tests::tenant::lean_relay_vectors_match_the_relay_routes	crates/gateway/src/routes/relay.rs	AND holder_subject = ?	AND (holder_subject = ? OR 1)
t1-operator-scope	opensesame-gateway	routes::relay::tests::tenant::lean_relay_vectors_match_the_relay_routes	crates/gateway/src/routes/relay_scope.rs	Ok((bootstrap.org, bootstrap.principal.to_string()))	Ok((opensesame_domain::OrganizationId::new(), bootstrap.principal.to_string()))
f1-submit	opensesame-gateway	routes::relay::tests::tenant::lean_relay_vectors_match_the_relay_routes	crates/gateway/src/routes/relay.rs	precedes the reply.\npub async fn submit(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {\n    if let Err(response) = caller_scope(&st, &headers) {\n        return response;\n    }\n    execution_unavailable()	precedes the reply.\npub async fn submit(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {\n    if let Err(response) = caller_scope(&st, &headers) {\n        return response;\n    }\n    StatusCode::ACCEPTED.into_response()
f1-relay-fallback	opensesame-gateway	routes::intents::delegated_invoke_tests::relay_mode_tests::lean_mode_vectors_match_delegated_invocation	crates/gateway/src/routes/intents_queue.rs	if mode != ExecutionMode::Broker {	if mode == ExecutionMode::Broker && mode != ExecutionMode::Relay {
f1-parse-fallback	opensesame-connection-broker	tests::delegation_mode_tests::lean_mode_vectors_match_parse_claim_and_resolution	crates/connection-broker/src/delegation_mode.rs	_ => Err(BrokerError::InvalidState),	_ => Ok(ExecutionMode::Broker),
f1-broker-claim	opensesame-connection-broker	tests::delegation_mode_tests::lean_mode_vectors_match_parse_claim_and_resolution	crates/connection-broker/src/delegation_mode.rs	ExecutionMode::Broker => Err(BrokerError::DelegationUnavailable),	ExecutionMode::Broker => Ok(mode),
CONTROLS
check_sources
echo "host-cli-formal: all negative controls detected"
