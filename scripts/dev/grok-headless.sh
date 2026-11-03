#!/usr/bin/env bash
# Subscription auth only (~/.grok/auth.json). Never use XAI_API_KEY.
# Unset API keys so a runtime secret cannot shadow the subscription login.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=scripts/dev/grok-git-signing.sh
source "$ROOT/scripts/dev/grok-git-signing.sh"
grok_configure_git_signing "$ROOT"
grok_configure_grok_hooks "$ROOT"
exec env -u XAI_API_KEY -u GROK_CODE_XAI_API_KEY -u GROK_DEPLOYMENT_KEY grok "$@"
