#!/usr/bin/env bash
# Git signing identity for Grok Build sessions. Sourced by grok-headless.sh.
set -euo pipefail

grok_resolve_signing_key() {
  if [[ -n "${OPENSESAME_GIT_SIGNING_KEY:-}" ]]; then
    printf '%s' "$OPENSESAME_GIT_SIGNING_KEY"
    return 0
  fi
  local configured=""
  configured="$(git config --get user.signingkey 2>/dev/null || true)"
  if [[ -n "$configured" ]]; then
    printf '%s' "$configured"
    return 0
  fi
  return 1
}

grok_configure_git_signing() {
  local root="${1:-}"
  if [[ -n "$root" ]]; then
    cd "$root"
  fi
  local key=""
  if ! key="$(grok_resolve_signing_key)"; then
    printf '%s\n' \
      "grok-headless: no SSH signing key is configured." \
      "Set OPENSESAME_GIT_SIGNING_KEY or git config user.signingkey before invoking Grok Build." >&2
    return 1
  fi
  git config commit.gpgsign true
  git config gpg.format ssh
  git config user.signingkey "$key"
  git config user.name 'Grok'
  git config user.email 'noreply@x.ai'
}

grok_configure_grok_hooks() {
  local root="${1:-}"
  if [[ -n "$root" ]]; then
    cd "$root"
  fi
  git config core.hooksPath .githooks-grok
  chmod +x .githooks-grok/pre-push
}
