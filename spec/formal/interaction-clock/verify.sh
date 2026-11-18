#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
lean_bin="${OPENSESAME_LEAN_BIN:-lean}"
if [[ -n "${OPENSESAME_INTERACTION_CLOCK_MUTANT:-}" ]]; then
  echo "interaction-clock-formal: a scratch mutant cannot be used as the verified implementation" >&2
  exit 1
fi
if ! command -v "$lean_bin" >/dev/null 2>&1 || [[ "$("$lean_bin" --version)" != "Lean (version 4.24.0,"* ]]; then
  echo "interaction-clock-formal: Lean 4.24.0 is required" >&2
  exit 1
fi
if [[ ! -x "$root/node_modules/.bin/vitest" ]]; then
  echo "interaction-clock-formal: install the repository's Node dependencies first" >&2
  exit 1
fi
vectors="$(mktemp "${TMPDIR:-/tmp}/opensesame-clock-vectors.XXXXXXXX")"
report="$(mktemp "${TMPDIR:-/tmp}/opensesame-clock-report.XXXXXXXX")"
trap 'rm -f "$vectors" "$report"' EXIT
cd "$root"
bash spec/formal/check-axioms.sh "$lean_bin" spec/formal/interaction-clock/InteractionClock.lean > "$vectors"
if [[ "$(wc -l < "$vectors")" -ne 252 ]]; then
  echo "interaction-clock-formal: expected 252 Lean vectors" >&2
  exit 1
fi
OPENSESAME_INTERACTION_CLOCK_VECTORS="$vectors" \
  "$root/node_modules/.bin/vitest" run --config spec/formal/interaction-clock/vitest.config.ts --maxWorkers=2 \
    --reporter=default --reporter=json --outputFile.json="$report"
node spec/formal/interaction-clock/check-report.mjs "$report"
node spec/formal/interaction-clock/check-drift.mjs
