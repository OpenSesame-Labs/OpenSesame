#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
lean_bin="${OPENSESAME_LEAN_BIN:-lean}"
cd "$root/spec/formal/auth"
if ! command -v "$lean_bin" >/dev/null 2>&1; then
  echo "auth-formal: Lean 4.24.0 is required; set OPENSESAME_LEAN_BIN or install the pinned toolchain" >&2
  exit 1
fi
if [[ "$("$lean_bin" --version)" != "Lean (version 4.24.0,"* ]]; then
  echo "auth-formal: expected Lean 4.24.0" >&2
  exit 1
fi
if [[ ! -x "$root/node_modules/.bin/vitest" ]]; then
  echo "auth-formal: install the repository's Node dependencies first" >&2
  exit 1
fi
vectors="$(mktemp "${TMPDIR:-/tmp}/opensesame-auth-formal.XXXXXXXX")"
report="$(mktemp "${TMPDIR:-/tmp}/opensesame-auth-vitest.XXXXXXXX")"
trap 'rm -f "$vectors" "$report"' EXIT
bash "$root/spec/formal/check-axioms.sh" "$lean_bin" "$root/spec/formal/auth/AuthPolicy.lean" > "$vectors"
cd "$root"
OPENSESAME_AUTH_FORMAL_VECTORS="$vectors" \
  "$root/node_modules/.bin/vitest" run --config spec/formal/auth/vitest.config.ts --maxWorkers=2 \
    --reporter=default --reporter=json --outputFile.json="$report"
node scripts/test/formal-vitest-report.mjs auth "$report" "$vectors" "$root"
node scripts/test/auth-formal-drift.mjs
