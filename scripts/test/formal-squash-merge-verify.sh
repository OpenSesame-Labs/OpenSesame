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
  spec/formal/spiffe; do
  rm -rf "$SCRATCH/$rel"
  cp -a "$ROOT/$rel" "$SCRATCH/$rel"
done
python3 - "$ROOT" "$SCRATCH" <<'PY'
import json, os, shutil, subprocess, sys
from pathlib import Path

root, scratch = map(Path, sys.argv[1:3])
# Branch-side diff only: three-dot against the merge-base. Main-only moves
# (manifests, covered sources) must survive in the simulation untouched.
branch_paths = set(
    subprocess.check_output(
        ["git", "-C", str(root), "diff", "--name-only", "origin/main...HEAD"],
        text=True,
    ).splitlines()
)
manifests = [
    scratch / "spec/formal/authority/coverage.json",
    scratch / "spec/formal/dpop/coverage.json",
    scratch / "spec/formal/spiffe/coverage.json",
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
        # Only sources this branch touched come from the branch checkout;
        # main-only advances keep the scratch (main) bytes.
        if rel not in branch_paths:
            continue
        dest = scratch / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / rel, dest)
# Start from origin/main's lock (the scratch worktree). Overlay Cargo.toml
# and Cargo.lock paths the branch changed relative to the merge-base,
# including a lock-only diff. Reconcile offline when either differs so the
# scratch resolution follows that diff instead of keeping main's lock. Use the
# minimal workspace update, not generate-lockfile: regenerating discards every
# locked version and re-resolves third-party crates to the newest compatible
# releases, which drifts reviewed dependency projections the branch never
# changed.
changed_manifests = [
    rel
    for rel in sorted(branch_paths)
    if rel == "Cargo.toml" or rel.endswith("/Cargo.toml")
]
changed_locks = [
    rel
    for rel in sorted(branch_paths)
    if rel == "Cargo.lock" or rel.endswith("/Cargo.lock")
]
for rel in changed_locks:
    dest = scratch / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(root / rel, dest)
for rel in changed_manifests:
    dest = scratch / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(root / rel, dest)
if changed_manifests or changed_locks:
    subprocess.run(
        ["cargo", "update", "--workspace", "--offline"],
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
  # A branch that leaves the authority, DPoP and SPIFFE inputs untouched
  # overlays no change, so the simulated squash is empty. Commit it anyway:
  # the drift checks below must still run against origin/main.
  git -c user.name="formal-squash-verify" -c user.email="formal-squash-verify@example.invalid" \
    commit -q --allow-empty -m "squash-sim: formal stack on origin/main"
)
python3 "$SCRATCH/spec/formal/authority/check-drift.py"
python3 "$SCRATCH/spec/formal/dpop/check_drift.py"
python3 "$SCRATCH/spec/formal/spiffe/check-drift.py"
run_spiffe_skip_lean_integration() {
  (
    cd "$SCRATCH"
    # Same Rust integration suites as spec/formal/spiffe/verify.sh after the
    # Lean correspondence step. No name filter: a new case in these binaries
    # still runs. Lean is not invoked.
    cargo test --locked -p opensesame-spiffe-source --all-features \
      --test synthetic_workload_api \
      --test withdrawal_policy \
      --test outage_policy \
      --test trust_reduction_policy \
      --test production_sink_policy
  )
}

if [[ "${OPENSESAME_FORMAL_SQUASH_SKIP_LEAN:-}" != "1" ]]; then
  (cd "$SCRATCH" && npm run verify:authority-formal && npm run verify:dpop-formal && npm run verify:spiffe-formal)
else
  echo "formal-squash-merge-verify: skipping Lean; running SPIFFE Rust integration suites" >&2
  run_spiffe_skip_lean_integration
fi
echo "formal-squash-merge-verify: ok (base origin/main $MAIN)"
