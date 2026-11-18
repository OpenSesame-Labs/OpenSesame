#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
if [[ -n "${OPENSESAME_OAUTH_MUTANT:-}" || -n "${OPENSESAME_OAUTH_TRUST_MUTANT:-}" ]]; then
  echo "oauth-formal: mutant overrides are not allowed in the verification gate" >&2
  exit 1
fi
lean_bin="${OPENSESAME_LEAN_BIN:-lean}"
cd "$root/spec/formal/oauth"
if ! command -v "$lean_bin" >/dev/null 2>&1 || [[ "$("$lean_bin" --version)" != "Lean (version 4.24.0,"* ]]; then
  echo "oauth-formal: Lean 4.24.0 is required" >&2
  exit 1
fi
if [[ ! -x "$root/node_modules/.bin/vitest" ]]; then
  echo "oauth-formal: install repository Node dependencies first" >&2
  exit 1
fi
temporary="$(mktemp -d "${TMPDIR:-/tmp}/opensesame-oauth-formal.XXXXXXXX")"
trap 'rm -rf "$temporary"' EXIT
vectors="$temporary/vectors"
report="$temporary/hosted-report.json"
bash "$root/spec/formal/check-axioms.sh" "$lean_bin" "$root/spec/formal/oauth/PendingIntegrity.lean" > "$vectors"
cd "$root"
(
  correspondence_report="$(mktemp "${TMPDIR:-/tmp}/opensesame-oauth-vitest.XXXXXXXX")"
  trap 'rm -f "$correspondence_report"' EXIT
  OPENSESAME_OAUTH_FORMAL_VECTORS="$vectors" "$root/node_modules/.bin/vitest" run --config spec/formal/oauth/vitest.config.ts --maxWorkers=2 \
    --reporter=default --reporter=json --outputFile.json="$correspondence_report"
  node scripts/test/formal-vitest-report.mjs oauth "$correspondence_report" "$vectors" "$root"
)
(
  cd "$root/packages/control-plane"
  "$root/node_modules/.bin/vitest" run src/__tests__/federated-interaction.test.ts \
    -t 'if the issuer changes organizations|admits the subject and joins it to the tenant' --maxWorkers=1 \
    --reporter=default --reporter=json --outputFile.json="$report"
)
node spec/formal/oauth/check-hosted-flow-report.mjs "$report"
node spec/formal/oauth/check-drift.mjs
