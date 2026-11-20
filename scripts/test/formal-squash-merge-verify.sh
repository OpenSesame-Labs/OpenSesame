#!/usr/bin/env bash
# Simulate squash-merging the formal stack onto origin/main and rerun drift (+ optional verify).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
git fetch origin main >/dev/null 2>&1 || true
MAIN="$(git rev-parse origin/main)"
SCRATCH="$(mktemp -d)"
trap 'git worktree remove -f "$SCRATCH" 2>/dev/null || rm -rf "$SCRATCH"' EXIT
git worktree add -f --detach "$SCRATCH" "$MAIN" >/dev/null
for rel in \
  scripts/security/formal_coverage_drift.py \
  scripts/security/cargo-lock-projection.py \
  spec/formal/check-axioms.sh \
  spec/formal/required-theorem-command.lean \
  spec/formal/authority \
  spec/formal/dpop \
  spec/formal/spiffe \
  spec/formal/source-lifetime; do
  rm -rf "$SCRATCH/$rel"
  cp -a "$ROOT/$rel" "$SCRATCH/$rel"
done
python3 - "$ROOT" "$SCRATCH" <<'PY'
import json, os, shutil, subprocess, sys
from pathlib import Path

root, scratch = map(Path, sys.argv[1:3])
manifests = [
    scratch / "spec/formal/authority/coverage.json",
    scratch / "spec/formal/dpop/coverage.json",
    scratch / "spec/formal/spiffe/coverage.json",
    scratch / "spec/formal/source-lifetime/coverage.json",
]
seen = set()
for manifest in manifests:
    if not manifest.exists():
        continue
    for item in json.loads(manifest.read_text()).get("sources", []):
        rel = item["path"]
        if rel in seen:
            continue
        seen.add(rel)
        if rel == "Cargo.lock" or rel.endswith("/Cargo.lock"):
            continue
        dest = scratch / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / rel, dest)
# Start from origin/main's lock (the scratch worktree) and overlay branch
# manifests. Regenerate the lock only when a manifest differs, so a branch
# Cargo.lock is not copied over main's resolution wholesale.
manifest_diff = subprocess.check_output(
    ["git", "-C", str(root), "diff", "--name-only", "origin/main", "HEAD"],
    text=True,
)
changed_manifests = [
    rel
    for rel in manifest_diff.splitlines()
    if rel == "Cargo.toml" or rel.endswith("/Cargo.toml")
]
for rel in changed_manifests:
    dest = scratch / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(root / rel, dest)
if changed_manifests:
    subprocess.run(
        ["cargo", "generate-lockfile", "--offline"],
        cwd=scratch,
        check=True,
        env={**os.environ, "CARGO_NET_OFFLINE": "true"},
    )
scratch_pkg = scratch / "package.json"
root_pkg = root / "package.json"
if scratch_pkg.exists() and root_pkg.exists():
    scratch_data = json.loads(scratch_pkg.read_text())
    root_scripts = json.loads(root_pkg.read_text()).get("scripts", {})
    scripts = scratch_data.setdefault("scripts", {})
    for key in (
        "verify:authority-formal",
        "verify:dpop-formal",
        "verify:spiffe-formal",
        "verify:source-lifetime-formal",
    ):
        if key in root_scripts:
            scripts[key] = root_scripts[key]
    scratch_pkg.write_text(json.dumps(scratch_data, indent=2) + "\n")
PY
(
  cd "$SCRATCH"
  # Identity is per invocation. `git config` here writes the shared repo
  # config and would replace the caller's name and email.
  git add -A
  git -c user.name="formal-squash-verify" -c user.email="formal-squash-verify@example.invalid" \
    commit -qm "squash-sim: formal stack on origin/main"
)
python3 "$SCRATCH/spec/formal/authority/check-drift.py"
python3 "$SCRATCH/spec/formal/dpop/check_drift.py"
python3 "$SCRATCH/spec/formal/spiffe/check-drift.py"
python3 "$SCRATCH/spec/formal/source-lifetime/check-drift.py"
run_spiffe_skip_lean_integration() {
  (
    cd "$SCRATCH"
    cargo test --locked -p opensesame-spiffe-source --all-features \
      --test withdrawal_policy --test trust_reduction_policy --test outage_policy -- \
      no_identity_issued_on_the_stream_withdraws_and_recovers \
      no_identity_denial_on_reconnect_withdraws_the_active_generation \
      rejected_profile_with_removed_anchor_withdraws \
      rejected_activation_after_reconnect_cannot_extend_the_outage \
      invalid_profile_after_reconnect_cannot_end_the_outage_or_extend_its_deadline
  )
}

if [[ "${OPENSESAME_FORMAL_SQUASH_SKIP_LEAN:-}" != "1" ]]; then
  (cd "$SCRATCH" && npm run verify:authority-formal && npm run verify:dpop-formal && npm run verify:spiffe-formal)
else
  # The full Lean verify scripts stay skipped. SPIFFE still runs vector
  # correspondence when Lean is present, and always runs the Lean-independent
  # integration tests that exercise withdrawal, trust reduction, and outage.
  lean_bin="${OPENSESAME_LEAN_BIN:-lean}"
  if command -v "$lean_bin" >/dev/null 2>&1; then
    vectors="$(mktemp "${TMPDIR:-/tmp}/opensesame-spiffe-formal.XXXXXXXX")"
    trap 'rm -f "$vectors"; git worktree remove -f "$SCRATCH" 2>/dev/null || rm -rf "$SCRATCH"' EXIT
    (
      cd "$SCRATCH/spec/formal/spiffe"
      bash "$SCRATCH/spec/formal/check-axioms.sh" "$lean_bin" "$SCRATCH/spec/formal/spiffe/SpiffePolicy.lean"
    ) > "$vectors"
    (
      cd "$SCRATCH"
      OPENSESAME_SPIFFE_VECTORS="$vectors" cargo test --locked -p opensesame-spiffe-source --all-features --lib \
        source::formal_tests::lean_vectors_match_the_sdk_classifier_and_outage_deadlines -- --ignored --exact
    )
  else
    echo "formal-squash-merge-verify: Lean unavailable; skipping SPIFFE vector correspondence" >&2
  fi
  run_spiffe_skip_lean_integration
fi
echo "formal-squash-merge-verify: ok (base origin/main $MAIN)"
