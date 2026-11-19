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
import json, shutil, sys
from pathlib import Path

root, scratch = map(Path, sys.argv[1:3])
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
        dest = scratch / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / rel, dest)
shutil.copy2(root / "Cargo.lock", scratch / "Cargo.lock")
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
  git config user.name "formal-squash-verify"
  git config user.email "formal-squash-verify@example.invalid"
  git add -A
  git commit -qm "squash-sim: formal stack on origin/main"
)
python3 "$SCRATCH/spec/formal/authority/check-drift.py"
python3 "$SCRATCH/spec/formal/dpop/check_drift.py"
python3 "$SCRATCH/spec/formal/spiffe/check-drift.py"
if [[ "${OPENSESAME_FORMAL_SQUASH_SKIP_LEAN:-}" != "1" ]]; then
  (cd "$SCRATCH" && npm run verify:authority-formal && npm run verify:dpop-formal && npm run verify:spiffe-formal)
fi
echo "formal-squash-merge-verify: ok (base origin/main $MAIN)"