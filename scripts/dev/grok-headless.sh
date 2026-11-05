#!/usr/bin/env bash
# Subscription auth only (~/.grok/auth.json). Never use XAI_API_KEY.
# Unset API keys so a runtime secret cannot shadow the subscription login.
# Single-turn runs (-p / --single, plus --prompt-file / --prompt-json) default
# to streaming-json and --no-alt-screen when the caller omitted --output-format,
# so a chunk log grows while the agent is still working. Explicit json is still
# forwarded for short probes, but it buffers until exit (a tee'd chunk log stays
# 0 bytes); warn on stderr. Flags go before the rest of the argv: `grok models`
# rejects a trailing --output-format.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=scripts/dev/grok-git-signing.sh
source "$ROOT/scripts/dev/grok-git-signing.sh"
grok_configure_git_signing "$ROOT"
grok_configure_grok_hooks "$ROOT"

extra=()
single=0
output_format_set=0
output_format_json=0
no_alt_set=0
prev=""
for arg in "$@"; do
  if [[ "$prev" == "--output-format" && "$arg" == "json" ]]; then
    output_format_json=1
  fi
  case "$arg" in
    -p|--single|--single=*|--prompt-file|--prompt-file=*|--prompt-json|--prompt-json=*)
      single=1
      ;;
    --output-format=json)
      output_format_set=1
      output_format_json=1
      ;;
    --output-format|--output-format=*)
      output_format_set=1
      ;;
    --no-alt-screen)
      no_alt_set=1
      ;;
  esac
  prev="$arg"
done
if [[ "$single" -eq 1 && "$output_format_json" -eq 1 ]]; then
  printf '%s\n' \
    'grok-headless: --output-format json buffers until exit; chunk logs stay 0 bytes while Grok runs. Use scripts/dev/grok-chunk-run.sh or omit --output-format (defaults to streaming-json).' >&2
fi
if [[ "$single" -eq 1 && "$output_format_set" -eq 0 ]]; then
  extra+=(--output-format streaming-json)
  if [[ "$no_alt_set" -eq 0 ]]; then
    extra+=(--no-alt-screen)
  fi
fi

exec env -u XAI_API_KEY -u GROK_CODE_XAI_API_KEY -u GROK_DEPLOYMENT_KEY grok "${extra[@]}" "$@"
