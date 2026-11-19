#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
lean_bin="${OPENSESAME_LEAN_BIN:-lean}"
rustc_bin="${OPENSESAME_RUSTC:-rustc}"
cd "$root/spec/formal/dpop"
if ! command -v "$lean_bin" >/dev/null 2>&1; then
  echo "dpop-formal: Lean 4.24.0 is required" >&2
  exit 1
fi
if [[ "$("$lean_bin" --version)" != "Lean (version 4.24.0,"* ]]; then
  echo "dpop-formal: expected Lean 4.24.0" >&2
  exit 1
fi
if ! command -v "$rustc_bin" >/dev/null 2>&1; then
  echo "dpop-formal: the repository's Rust compiler is required" >&2
  exit 1
fi
rust_version="$(python3 -c 'import sys,tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["toolchain"]["channel"])' "$root/rust-toolchain.toml")"
if [[ "$("$rustc_bin" --version)" != "rustc $rust_version "* ]]; then
  echo "dpop-formal: expected rustc $rust_version" >&2
  exit 1
fi
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--negative-controls" ) ]]; then
  echo "usage: $0 [--negative-controls]" >&2
  exit 2
fi
tmp="$(mktemp -d "${TMPDIR:-/tmp}/opensesame-dpop-formal.XXXXXXXX")"
trap 'rm -rf "$tmp"' EXIT
bash "$root/spec/formal/check-axioms.sh" "$lean_bin" "$root/spec/formal/dpop/ReplayPolicy.lean" > "$tmp/vectors.tsv"
source="$root/crates/proof/src/replay.rs"
harness="$root/spec/formal/dpop/replay_conformance.rs"
DPOP_REPLAY_SOURCE="$source" "$rustc_bin" --edition=2021 "$harness" -o "$tmp/conformance"
"$tmp/conformance" "$tmp/vectors.tsv"
python3 "$root/spec/formal/dpop/check_drift.py"

if [[ "${1:-}" == "--negative-controls" ]]; then
  python3 "$root/spec/formal/dpop/mutate.py" "$source" "$tmp"
  for mutation in expiry-boundary proof-window duplicate-check capacity-check empty-jti oversized-jti; do
    DPOP_REPLAY_SOURCE="$tmp/$mutation.rs" "$rustc_bin" --edition=2021 "$harness" -o "$tmp/mutant"
    if "$tmp/mutant" "$tmp/vectors.tsv" > "$tmp/$mutation.log" 2>&1; then
      echo "dpop-formal: negative control was not detected: $mutation" >&2
      exit 1
    fi
    if ! grep -q 'decision mismatch' "$tmp/$mutation.log"; then
      echo "dpop-formal: $mutation failed without the expected correspondence assertion" >&2
      cat "$tmp/$mutation.log" >&2
      exit 1
    fi
    echo "dpop-formal: detected negative control $mutation"
  done
fi
