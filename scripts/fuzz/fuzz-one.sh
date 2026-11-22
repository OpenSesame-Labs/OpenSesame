#!/usr/bin/env bash
# Run one target with the same private, complete seeds as the audit gates.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ $# -lt 1 ]]; then
  echo "usage: bash scripts/fuzz/fuzz-one.sh <target> [-- <libFuzzer options>]" >&2
  exit 2
fi
target="$1"
shift
if [[ "${1:-}" == -- ]]; then shift; fi
cd "$ROOT"
source "$ROOT/scripts/lib/fuzz-directory.sh"
opensesame_fuzz_corpus "$target"
exec cargo "+${OPENSESAME_FUZZ_TOOLCHAIN:-nightly}" fuzz run "$target" \
  --fuzz-dir tests/fuzz/cargo "$corpus" -- \
  "-artifact_prefix=$OPENSESAME_AUDIT_DIR/artifacts/" "$@"
