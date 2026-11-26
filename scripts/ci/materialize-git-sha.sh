#!/usr/bin/env bash
# Materialize an exact commit at a path without actions/checkout.
set -euo pipefail
TARGET_SHA="${TARGET_SHA:-${PR_VISUAL_HEAD_SHA:-}}"
: "${TARGET_SHA:?}"
: "${GITHUB_REPOSITORY:?}"
: "${GITHUB_TOKEN:?}"
target_dir="${1:-.}"
mkdir -p "$target_dir"
git -C "$target_dir" init -q
git -C "$target_dir" remote add origin "https://github.com/${GITHUB_REPOSITORY}.git"
auth_header="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')"
GIT_CONFIG_COUNT=1 \
  GIT_CONFIG_KEY_0=http.https://github.com/.extraheader \
  GIT_CONFIG_VALUE_0="AUTHORIZATION: basic ${auth_header}" \
  git -C "$target_dir" fetch --no-tags --depth 1 origin "$TARGET_SHA"
unset auth_header
git -C "$target_dir" checkout -q FETCH_HEAD
git -C "$target_dir" remote remove origin
test "$(git -C "$target_dir" rev-parse HEAD)" = "$TARGET_SHA"
if git -C "$target_dir" config --local --get-regexp 'http\..*\.extraheader' > /dev/null; then
  echo "materialized tree unexpectedly persisted credentials" >&2
  exit 1
fi
