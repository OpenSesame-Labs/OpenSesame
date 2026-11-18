#!/usr/bin/env bash
# Public tracked seeds are read-only inputs; all fuzz growth stays private.
source "$ROOT/scripts/lib/audit-directory.sh"
opensesame_audit_directory
mkdir -p "$OPENSESAME_AUDIT_DIR/artifacts" "$OPENSESAME_AUDIT_DIR/corpus"

opensesame_fuzz_corpus() {
  local target="$1" seed destination kind
  [[ "$target" =~ ^[a-zA-Z0-9_-]+$ ]] || return 1
  corpus="$OPENSESAME_AUDIT_DIR/corpus/$target"
  mkdir -p "$corpus"
  git -C "$ROOT" ls-files -z -- "tests/fuzz/cargo/corpus/$target/" "tests/fuzz/cargo/regressions/$target/" > "$OPENSESAME_AUDIT_DIR/$target-seeds"
  while IFS= read -r -d '' seed; do
    [[ -f "$ROOT/$seed" && ! -L "$ROOT/$seed" ]] || continue
    case "$seed" in
      tests/fuzz/cargo/corpus/*) kind=corpus ;;
      tests/fuzz/cargo/regressions/*) kind=regression ;;
      *) return 1 ;;
    esac
    destination="$corpus/$kind-$(basename "$seed")"
    [[ ! -e "$destination" ]] || return 1
    cp -- "$ROOT/$seed" "$destination"
  done < "$OPENSESAME_AUDIT_DIR/$target-seeds"
  local archive="tests/fuzz/cargo/seed-archives/$target.zip"
  if git -C "$ROOT" ls-files --error-unmatch -- "$archive" >/dev/null 2>&1; then
    [[ -f "$ROOT/$archive" && ! -L "$ROOT/$archive" ]] || return 1
    python3 "$ROOT/scripts/lib/extract-fuzz-seeds.py" "$ROOT/$archive" "$corpus" || return 1
  fi
}
