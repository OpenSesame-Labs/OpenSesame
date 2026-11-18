#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
lean_bin="${OPENSESAME_LEAN_BIN:-lean}"
if ! command -v "$lean_bin" >/dev/null 2>&1 || [[ "$("$lean_bin" --version)" != "Lean (version 4.24.0,"* ]]; then
  echo "source-trust-selection-formal: Lean 4.24.0 is required" >&2
  exit 1
fi
scratch="$(mktemp -d "${TMPDIR:-/tmp}/opensesame-source-selection.XXXXXXXX")"
trap 'rm -rf "$scratch"' EXIT
cd "$root"
# Check reviewed source and optional build scripts before Cargo can execute.
python3 -I spec/formal/source-trust-selection/check-drift.py
bash spec/formal/check-axioms.sh "$lean_bin" \
  "$root/spec/formal/source-trust-selection/SourceTrustSelection.lean" > "$scratch/vectors"
required="transport::boot::source_trust_selection::formal::lean_vectors_match_source_trust_selection"
OPENSESAME_SOURCE_SELECTION_VECTORS="$scratch/vectors" CARGO_INCREMENTAL=0 \
  cargo test --locked -p opensesame-gateway --lib "$required" -- --ignored --exact | tee "$scratch/correspondence"
if [[ "$(grep -Fxc "test $required ... ok" "$scratch/correspondence" || true)" != 1 ]] ||
   ! grep -Eq '^test result: ok\. 1 passed; 0 failed; 0 ignored;' "$scratch/correspondence"; then
  echo "source-trust-selection-formal: required selector correspondence did not run and pass" >&2
  exit 1
fi
exact="transport::boot::source_trust_selection::formal::returns_exact_requested_source_bundle"
CARGO_INCREMENTAL=0 cargo test --locked -p opensesame-gateway --lib "$exact" -- --exact | tee "$scratch/exact"
if [[ "$(grep -Fxc "test $exact ... ok" "$scratch/exact" || true)" != 1 ]] ||
   ! grep -Eq '^test result: ok\. 1 passed; 0 failed; 0 ignored;' "$scratch/exact"; then
  echo "source-trust-selection-formal: exact source bundle regression did not run and pass" >&2
  exit 1
fi
live="transport::boot::source_trust_tests::restart_cannot_use_a_stored_bundle_for_a_source_selected_domain"
CARGO_INCREMENTAL=0 cargo test --locked -p opensesame-gateway --lib "$live" -- --exact | tee "$scratch/live"
if [[ "$(grep -Fxc "test $live ... ok" "$scratch/live" || true)" != 1 ]] ||
   ! grep -Eq '^test result: ok\. 1 passed; 0 failed; 0 ignored;' "$scratch/live"; then
  echo "source-trust-selection-formal: required source trust regression did not run and pass" >&2
  exit 1
fi
python3 -I spec/formal/source-trust-selection/check-drift.py
