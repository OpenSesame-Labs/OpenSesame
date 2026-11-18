#!/usr/bin/env bash
# Public tracked seeds are read-only inputs; all fuzz growth stays private.
source "$ROOT/scripts/lib/audit-directory.sh"
opensesame_audit_directory
mkdir -p "$OPENSESAME_AUDIT_DIR/artifacts" "$OPENSESAME_AUDIT_DIR/corpus"

opensesame_fuzz_corpus() {
  local target="$1" seed destination bundle
  [[ "$target" =~ ^[a-zA-Z0-9_-]+$ ]] || return 1
  corpus="$OPENSESAME_AUDIT_DIR/corpus/$target"
  mkdir -p "$corpus" || return 1
  if [[ "$target" == capability_algebra ]]; then
    bundle="tests/fuzz/cargo/corpus-bundles/capability_algebra.json"
    if ! git -C "$ROOT" ls-files --error-unmatch -- "$bundle" >/dev/null 2>&1; then
      echo "fuzz-directory: capability corpus bundle is not tracked" >&2
      return 1
    fi
    destination="$corpus/tests/fuzz/cargo/corpus/$target"
    mkdir -p "$(dirname "$destination")" || return 1
    python3 "$ROOT/scripts/fuzz/capability-corpus.py" materialize "$ROOT/$bundle" "$destination" || return 1
  fi
  git -C "$ROOT" ls-files -z -- "tests/fuzz/cargo/corpus/$target/" "tests/fuzz/cargo/regressions/$target/" > "$OPENSESAME_AUDIT_DIR/$target-seeds" || return 1
  while IFS= read -r -d '' seed; do
    [[ -f "$ROOT/$seed" && ! -L "$ROOT/$seed" ]] || continue
    destination="$corpus/$seed"
    mkdir -p "$(dirname "$destination")" || return 1
    if [[ -e "$destination" || -L "$destination" ]]; then
      if [[ ! -f "$destination" || -L "$destination" ]] || ! cmp -s -- "$ROOT/$seed" "$destination"; then
        echo "fuzz-directory: seed conflicts with bundle: $seed" >&2
        return 1
      fi
    else
      cp -- "$ROOT/$seed" "$destination" || return 1
    fi
  done < "$OPENSESAME_AUDIT_DIR/$target-seeds"
}
