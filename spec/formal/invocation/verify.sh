#!/usr/bin/env bash
# INV-I1: Lean decides every retry case; the real broker replays each one.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
lean_bin="${OPENSESAME_LEAN_BIN:-lean}"
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--negative-controls" ) ]]; then
  echo "usage: $0 [--negative-controls]" >&2
  exit 2
fi
if ! command -v "$lean_bin" >/dev/null 2>&1 || [[ "$("$lean_bin" --version)" != "Lean (version 4.24.0,"* ]]; then
  echo "invocation-formal: Lean 4.24.0 is required" >&2
  exit 1
fi
drift() {
  python3 -I - "$1" <<'PY'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
sys.path.insert(0, str(root / "scripts" / "security"))
from formal_coverage_drift import assert_reviewed_revision_on_main, assert_worktree_sources
coverage = json.loads((root / "spec/formal/invocation/coverage.json").read_text())
if coverage.get("version") != 1 or not coverage.get("sources"):
    raise SystemExit("invocation-formal: invalid covered-source manifest")
assert_reviewed_revision_on_main(root, str(coverage.get("reviewed_revision", "")), "invocation-formal")
assert_worktree_sources(root, coverage["sources"], "invocation-formal")
print("invocation-formal: covered sources match coverage.json")
PY
}
scratch="$(mktemp -d "${TMPDIR:-/tmp}/opensesame-invocation-formal.XXXXXXXX")"
trap 'git -C "$root" worktree remove --force "$scratch/tree" >/dev/null 2>&1 || true; rm -rf "$scratch"' EXIT
vectors="$scratch/vectors.tsv"
drift "$root"
bash "$root/spec/formal/check-axioms.sh" "$lean_bin" "$root/spec/formal/invocation/Invocation.lean" > "$vectors"
correspond() {
  (cd "$1" && OPENSESAME_INVOCATION_VECTORS="$vectors" CARGO_TARGET_DIR="$2" \
    cargo test --locked -p opensesame-broker --test adversarial_broker -- \
    --ignored --exact invocation_binding_tests::lean_retry_vectors_match_the_broker --nocapture)
}
correspond "$root" "${CARGO_TARGET_DIR:-$scratch/target}"
drift "$root"
if [[ "${1:-}" == "--negative-controls" ]]; then
  # Mutants are built in a detached worktree of HEAD; the checkout is untouched.
  if [[ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]]; then
    echo "invocation-formal: negative controls need a clean worktree" >&2
    exit 1
  fi
  git -C "$root" worktree add --quiet --detach "$scratch/tree" HEAD
  controls=(
    "crates/broker/src/idempotency.rs|existing.fingerprint.as_ref() == Some(fingerprint),|true,|fingerprint"
    "crates/broker/src/idempotency.rs|&& self.signer.verify_receipt(&receipt).is_ok()||signature"
    "crates/broker/src/idempotency.rs|receipt.has_opaque_result()|true|opaque"
    "crates/broker/src/idempotency.rs|&& receipt.intent_digest == intent_commitment||intent"
    "crates/broker/src/idempotency.rs|&& receipt.idempotency_binding.as_deref() == Some(commitment.as_str()),|,|binding"
    "crates/broker/src/lib.rs|                decision.decision,|                true,|policy"
    "crates/broker/src/lib.rs|            !replay_only,|            true,|replay"
  )
  for control in "${controls[@]}"; do
    IFS='|' read -r file before after name <<<"$control"
    python3 -I - "$scratch/tree/$file" "$before" "$after" <<'PY'
import sys
path, before, after = sys.argv[1:]
text = open(path).read()
if text.count(before) != 1:
    raise SystemExit(f"mutation target must occur once: {before}")
open(path, "w").write(text.replace(before, after))
PY
    if correspond "$scratch/tree" "$scratch/target" > "$scratch/$name.log" 2>&1; then
      echo "invocation-formal: negative control was not detected: $name" >&2
      exit 1
    fi
    if ! grep -q 'vector:' "$scratch/$name.log"; then
      echo "invocation-formal: $name failed without a correspondence assertion" >&2
      tail -20 "$scratch/$name.log" >&2
      exit 1
    fi
    git -C "$scratch/tree" checkout --quiet -- "$file"
    echo "invocation-formal: detected negative control $name"
  done
fi
