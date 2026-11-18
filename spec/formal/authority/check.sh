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
rustc_bin="${RUSTC:-rustc}"
rust_version="$(python3 -c 'import sys,tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["toolchain"]["channel"])' "$root/rust-toolchain.toml")"
if ! command -v "$rustc_bin" >/dev/null 2>&1 || [[ "$("$rustc_bin" --version)" != "rustc $rust_version "* ]]; then
  echo "authority-formal: expected rustc $rust_version" >&2
  exit 1
fi
scratch="$(mktemp -d "${TMPDIR:-/tmp}/opensesame-authority-formal.XXXXXXXX")"
trap 'rm -rf "$scratch"' EXIT
vectors="$scratch/vectors.tsv"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$scratch/target}"
python3 "$root/spec/formal/authority/check-drift.py"
bash "$root/spec/formal/check-axioms.sh" "$lean_bin" "$root/spec/formal/authority/Authority.lean" > "$vectors"
cargo run --locked --manifest-path "$root/spec/formal/authority/Cargo.toml" -- "$vectors"
python3 "$root/spec/formal/authority/check-drift.py"
