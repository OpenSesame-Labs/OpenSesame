#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
lean_bin="${OPENSESAME_LEAN_BIN:-lean}"
cd "$root/spec/formal/authority"
if ! command -v "$lean_bin" >/dev/null 2>&1; then
  echo "authority-formal: Lean 4.24.0 is required" >&2
  exit 1
fi
if [[ "$("$lean_bin" --version)" != "Lean (version 4.24.0,"* ]]; then
  echo "authority-formal: expected Lean 4.24.0" >&2
  exit 1
fi
rustc_bin="${OPENSESAME_RUSTC:-${RUSTC:-rustc}}"
rust_version="$(python3 -I -c 'import sys,tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["toolchain"]["channel"])' "$root/rust-toolchain.toml")"
if ! command -v "$rustc_bin" >/dev/null 2>&1 || [[ "$("$rustc_bin" --version)" != "rustc $rust_version "* ]]; then
  echo "authority-formal: expected rustc $rust_version" >&2
  exit 1
fi
scratch="$(mktemp -d "${TMPDIR:-/tmp}/opensesame-authority-formal.XXXXXXXX")"
trap 'rm -rf "$scratch"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
vectors="$scratch/vectors.tsv"
python3 -I "$root/spec/formal/authority/check-drift.py"
# This harness is a separate Cargo workspace: its domain path dependency is
# outside that workspace, so a workspace wrapper alone cannot isolate it.
export CARGO_TARGET_DIR="$scratch/target"
export RUSTC_WRAPPER=""
unset OPENSESAME_FORMAL_RUSTC_LOG
export RUSTC_WORKSPACE_WRAPPER="$(python3 -I "$root/scripts/security/formal-cargo-isolation.py" "$root/spec/formal/authority")"
python3 -I "$root/scripts/security/formal-cargo-freshness.py" init \
  --repo "$root" --manifest "$root/spec/formal/authority/Cargo.toml" \
  --state "$scratch/cargo-state.json" --package opensesame-formal-authority \
  --reviewed-patch sqlx-sqlite=patches/vendor/sqlx-sqlite-0.9.0
bash "$root/spec/formal/check-axioms.sh" "$lean_bin" "$root/spec/formal/authority/Authority.lean" > "$vectors"
OPENSESAME_RUSTC="$rustc_bin" RUSTC="$rustc_bin" python3 -I "$root/scripts/security/formal-cargo-freshness.py" run \
  --state "$scratch/cargo-state.json" --input-check "$root/spec/formal/authority/check-drift.py" -- \
  run --locked --manifest-path "$root/spec/formal/authority/Cargo.toml" --bin authority-conformance -- "$vectors"
python3 -I "$root/spec/formal/authority/check-drift.py"
