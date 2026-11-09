#!/usr/bin/env bash
# betterleaks gate — secret scan of the working tree and the full git history.
#
# Config is `.betterleaks.toml`, which extends `.gitleaks.toml` (path pruning)
# and adds the reviewed exemptions for the rules gitleaks 8.x does not ship.
# Install the pinned binary with `scripts/dev/install-betterleaks.sh`.
#
# Working tree: any finding not covered by the digest-bound review manifest
#   (scripts/security/gitleaks-reviewed-working-tree.json) fails the gate.
# History:      reported; fails only with OPENSESAME_BETTERLEAKS_HISTORY_FAIL=1.
#
# Never passes `--validation`: that flag sends candidate secrets to the
# provider's live API. Raw reports hold the matched text, so they stay in a fresh
# 0700 directory outside the checkout and only digests are ever printed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/audit-directory.sh"
opensesame_audit_directory

BL="$(command -v betterleaks || true)"
[[ -n "$BL" ]] || { [[ -x "$ROOT/.tools/bin/betterleaks" ]] && BL="$ROOT/.tools/bin/betterleaks"; } || true
if [[ -z "$BL" ]]; then
  echo "betterleaks not installed; run scripts/dev/install-betterleaks.sh" >&2
  exit 1
fi
if [[ -n "${BETTERLEAKS_VALIDATION:-}" ]]; then
  echo "betterleaks gate: refusing to run with BETTERLEAKS_VALIDATION set (would contact provider APIs)" >&2
  exit 1
fi
echo "betterleaks $("$BL" version) ($BL)" >&2

# `extend.path` in .betterleaks.toml is resolved against the working directory.
CFG=".betterleaks.toml"
REPORT_DIR="$OPENSESAME_AUDIT_DIR/betterleaks-dir.json"
REPORT_GIT="$OPENSESAME_AUDIT_DIR/betterleaks-git.json"

WORK_DIR="$(mktemp -d "$OPENSESAME_AUDIT_DIR/.betterleaks-private.XXXXXXXX")"
chmod 700 "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT
REVIEW_MANIFEST="$ROOT/scripts/security/gitleaks-reviewed-working-tree.json"
REVIEW_GATE="$ROOT/scripts/security/gitleaks-working-tree-gate.mjs"

"$BL" config check --config "$CFG" >/dev/null

node "$REVIEW_GATE" prepare "$ROOT" "$REVIEW_MANIFEST" "$WORK_DIR/state.json"
echo "==> betterleaks dir (working tree)"
set +e
"$BL" dir . \
  --config "$CFG" \
  --report-path "$WORK_DIR/raw.json" \
  --report-format json \
  --no-banner \
  --log-level error >"$WORK_DIR/scanner-output" 2>&1
dir_status=$?
set -e
if [[ "$dir_status" -gt 1 ]]; then
  echo "betterleaks gate: FAIL (scanner error status=$dir_status)" >&2
  exit 1
fi
# classify expects a JSON array. Betterleaks writes `[]` when clean; do not depend on it.
[[ -f "$WORK_DIR/raw.json" ]] || printf '[]\n' > "$WORK_DIR/raw.json"
if ! node "$REVIEW_GATE" classify "$ROOT" "$REVIEW_MANIFEST" "$WORK_DIR/state.json" \
  "$WORK_DIR/raw.json" "$REPORT_DIR" "$dir_status"; then
  echo "betterleaks gate: FAIL (unreviewed finding or invalid evidence)" >&2
  echo "  -> digests only: $REPORT_DIR" >&2
  exit 1
fi

# `betterleaks git` walks every ref, not just HEAD: stale branches are in scope.
echo "==> betterleaks git (full history, all refs)"
if [[ "$(git rev-parse --is-shallow-repository 2>/dev/null)" == "true" ]]; then
  echo "betterleaks gate: WARN (shallow clone; history scan covers only the fetched commits)" >&2
fi
set +e
"$BL" git . \
  --config "$CFG" \
  --report-path "$REPORT_GIT" \
  --report-format json \
  --redact=100 \
  --no-banner \
  --log-level error
git_status=$?
set -e
if [[ "$git_status" -gt 1 ]]; then
  echo "betterleaks gate: FAIL (git scanner error status=$git_status)" >&2
  exit 1
fi
if [[ "$git_status" -eq 1 ]]; then
  if [[ "${OPENSESAME_BETTERLEAKS_HISTORY_FAIL:-}" == "1" ]]; then
    echo "betterleaks gate: FAIL (git history findings; OPENSESAME_BETTERLEAKS_HISTORY_FAIL=1)" >&2
    echo "  -> redacted report: $REPORT_GIT" >&2
    exit 1
  fi
  echo "betterleaks gate: WARN (git history findings present; no unreviewed working-tree findings)"
  echo "  -> redacted report: $REPORT_GIT"
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::warning title=betterleaks history::Git history findings remain; the working tree is clean. Set OPENSESAME_BETTERLEAKS_HISTORY_FAIL=1 to enforce."
  fi
  echo "betterleaks gate: PASS (history findings remain)"
else
  echo "betterleaks gate: CLEAN (no unreviewed working-tree findings; git history clean)"
fi
exit 0
