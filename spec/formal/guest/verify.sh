#!/usr/bin/env bash
# Check the abstract AUTH-C1 / GUEST-V1 contract model. No implementation is
# mapped to it, so this proves the model's stated contract only.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
lean_bin="${OPENSESAME_LEAN_BIN:-lean}"
if ! command -v "$lean_bin" >/dev/null 2>&1 || [[ "$("$lean_bin" --version)" != "Lean (version 4.24.0,"* ]]; then
  echo "guest-contract-formal: Lean 4.24.0 is required" >&2
  exit 1
fi
cases="$(bash "$root/spec/formal/check-axioms.sh" "$lean_bin" "$root/spec/formal/guest/GuestContract.lean")"
echo "guest-contract-formal: 16 contract obligations checked; $(printf '%s\n' "$cases" | wc -l | tr -d ' ') admission cases emitted"
