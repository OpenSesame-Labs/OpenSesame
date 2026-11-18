#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
lean_bin="${OPENSESAME_LEAN_BIN:-lean}"
if [[ -n "${OPENSESAME_APPROVAL_MUTANT:-}" ]]; then
  echo "webauthn-formal: a scratch mutant cannot be used as the verified implementation" >&2
  exit 1
fi
cd "$root/spec/formal/auth"
if ! command -v "$lean_bin" >/dev/null 2>&1 || [[ "$("$lean_bin" --version)" != "Lean (version 4.24.0,"* ]]; then
  echo "webauthn-formal: Lean 4.24.0 is required" >&2
  exit 1
fi
if [[ ! -x "$root/node_modules/.bin/vitest" ]]; then
  echo "webauthn-formal: install the repository's Node dependencies first" >&2
  exit 1
fi
vectors="$(mktemp "${TMPDIR:-/tmp}/opensesame-approval-formal.XXXXXXXX")"
trap 'rm -f "$vectors"' EXIT
bash "$root/spec/formal/check-axioms.sh" "$lean_bin" "$root/spec/formal/webauthn/ApprovalBinding.lean" > "$vectors"
cd "$root"
OPENSESAME_APPROVAL_VECTORS="$vectors" \
  "$root/node_modules/.bin/vitest" run --config spec/formal/webauthn/vitest.config.ts --maxWorkers=2
node spec/formal/webauthn/check-drift.mjs
