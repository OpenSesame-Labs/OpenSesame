#!/usr/bin/env bash
# Stream one headless Grok chunk. Append the log; the caller deletes it first.
# Heartbeat lines are omitted from the idle byte count so a quiet stream still
# times out while the 30s heartbeat is running.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

LOG="${1:?log path}"
PROMPT_FILE="${2:?prompt file}"
STDERR="${LOG%.log}.stderr"
DEBUG="${LOG%.log}.grok-debug"
WALL="${GROK_CHUNK_WALL_TIMEOUT:-1800}"
IDLE="${GROK_CHUNK_IDLE_TIMEOUT:-300}"
HEARTBEAT_EVERY=30

MODEL="$("$ROOT/scripts/dev/grok-resolve-model.sh")"
touch -- "$STDERR"
printf '[start %s] chunk log=%s prompt=%s\n' "$(date -Iseconds)" "$LOG" "$PROMPT_FILE" | tee -a "$LOG"

setsid "$ROOT/scripts/dev/grok-headless.sh" \
  --debug-file "$DEBUG" \
  -m "$MODEL" \
  --always-approve \
  --prompt-file "$PROMPT_FILE" \
  >>"$LOG" 2> >(tee -a "$STDERR" >&2) </dev/null &
CHILD=$!

hb_bytes=0
start_ts="$(date +%s)"
last_change="$start_ts"
next_hb=$((start_ts + HEARTBEAT_EVERY))
reason=""

payload_bytes() {
  local log_b err_b
  log_b="$(wc -c <"$LOG")"
  err_b="$(wc -c <"$STDERR")"
  printf '%s\n' "$((log_b + err_b - hb_bytes))"
}

last_payload="$(payload_bytes)"

stop_child() {
  if [[ -z "${CHILD:-}" ]] || ! kill -0 "$CHILD" 2>/dev/null; then
    return 0
  fi
  kill -- "-${CHILD}" 2>/dev/null || kill "$CHILD" 2>/dev/null || true
  sleep 1
  kill -KILL -- "-${CHILD}" 2>/dev/null || kill -KILL "$CHILD" 2>/dev/null || true
}
trap stop_child EXIT

while kill -0 "$CHILD" 2>/dev/null; do
  sleep 1
  if ! kill -0 "$CHILD" 2>/dev/null; then
    break
  fi
  now="$(date +%s)"
  payload="$(payload_bytes)"
  if [[ "$payload" != "$last_payload" ]]; then
    last_payload="$payload"
    last_change="$now"
  fi
  if (( now - start_ts >= WALL )); then
    reason="wall"
    break
  fi
  if (( now - last_change >= IDLE )); then
    reason="idle"
    break
  fi
  if (( now >= next_hb )); then
    msg="[heartbeat $(date -Iseconds)] still running pid=${CHILD}"
    printf '%s\n' "$msg" >>"$LOG"
    hb_bytes=$((hb_bytes + ${#msg} + 1))
    next_hb=$((now + HEARTBEAT_EVERY))
  fi
done

if [[ -n "$reason" ]]; then
  printf '[timeout %s] %s pid=%s\n' "$(date -Iseconds)" "$reason" "$CHILD" | tee -a "$LOG"
  stop_child
fi

set +e
wait "$CHILD"
EXIT=$?
set -e
if [[ -n "$reason" ]]; then
  EXIT=124
fi
printf '[end %s] exit=%s bytes=%s\n' "$(date -Iseconds)" "$EXIT" "$(wc -c <"$LOG")" | tee -a "$LOG"
trap - EXIT
exit "$EXIT"
