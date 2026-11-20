#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
suite="$(cd "$(dirname "$0")" && pwd)"
lean_bin="${OPENSESAME_LEAN_BIN:-lean}"
checker="$root/spec/formal/check-axioms.sh"
if ! command -v "$lean_bin" >/dev/null 2>&1; then
  echo "spiffe-formal: Lean 4.24.0 is required" >&2
  exit 1
fi
lean_version="$(cd "$suite" && "$lean_bin" --version)"
if [[ "$lean_version" != "Lean (version 4.24.0,"* ]]; then
  echo "spiffe-formal: Lean 4.24.0 is required" >&2
  exit 1
fi
if [[ ! -f "$checker" ]]; then
  echo "spiffe-formal: the shared formal checker has not been integrated" >&2
  exit 1
fi
vectors="$(mktemp "${TMPDIR:-/tmp}/opensesame-spiffe-formal.XXXXXXXX")"
test_output="$(mktemp "${TMPDIR:-/tmp}/opensesame-spiffe-correspondence.XXXXXXXX")"
trap 'rm -f "$vectors" "$test_output"' EXIT
correspondence_test="source::formal_tests::lean_vectors_match_the_sdk_classifier_and_outage_deadlines"
cd "$root/spec/formal/spiffe"
bash "$checker" "$lean_bin" "$root/spec/formal/spiffe/SpiffePolicy.lean" > "$vectors"
cd "$root"
OPENSESAME_SPIFFE_VECTORS="$vectors" cargo test --locked -p opensesame-spiffe-source \
  --all-features --lib "$correspondence_test" -- --ignored --exact | tee "$test_output"
if [[ "$(grep -Fxc "test $correspondence_test ... ok" "$test_output" || true)" != 1 ]] ||
   ! grep -Eq '^test result: ok\. 1 passed; 0 failed; 0 ignored;' "$test_output"; then
  echo "spiffe-formal: required Lean correspondence test did not run and pass" >&2
  exit 1
fi
cargo test --locked -p opensesame-spiffe-source --all-features \
  --test synthetic_workload_api --test withdrawal_policy --test outage_policy --test trust_reduction_policy --test production_sink_policy
env -u OPENSESAME_SPIFFE_NEGATIVE_CONTROLS python3 spec/formal/spiffe/check-drift.py
