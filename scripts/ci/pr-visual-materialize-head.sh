#!/usr/bin/env bash
# Materialize the PR head directory beside trusted base (CodeQL untrusted-checkout).
set -euo pipefail
: "${PR_VISUAL_HEAD_SHA:?}"
exec bash "$(dirname "$0")/materialize-git-sha.sh" "${1:-head}"