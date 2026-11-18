#!/usr/bin/env bash
# Run one target with the same reviewed, private seed corpus as the gates.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/lib/fuzz-directory.sh"
target="${1:?usage: fuzz-one.sh TARGET [libFuzzer arguments...]}"
shift
opensesame_fuzz_corpus "$target"
cd "$ROOT"
cargo +nightly fuzz run "$target" --fuzz-dir tests/fuzz/cargo "$corpus" -- "$@"
