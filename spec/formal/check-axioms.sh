#!/usr/bin/env bash
# Require each suite's reviewed theorems, then reject unapproved axioms.
set -euo pipefail
if [[ $# -ne 2 ]]; then
  echo "usage: $0 LEAN MODEL.lean" >&2
  exit 2
fi
lean_bin="$1"
model="$2"
root="$(cd "$(dirname "$0")/../.." && pwd)"
extra=""
case "${model##*/}" in
  AuthPolicy.lean) suite=auth; required_count=28 ;;
  Authority.lean) suite=authority; required_count=27 ;;
  ReplayPolicy.lean) suite=dpop; required_count=12 ;;
  SpiffePolicy.lean) suite=spiffe; required_count=25 ;;
  PendingIntegrity.lean) suite=oauth; required_count=22 ;;
  ApprovalBinding.lean) suite=webauthn; required_count=12 ;;
  InteractionClock.lean) suite=interaction-clock; required_count=13 ;;
  SourceLifetime.lean) suite=source-lifetime; required_count=13 ;;
  SourceTrustSelection.lean) suite=source-trust-selection; required_count=39 ;;
  SpiffePeerDomain.lean) suite=spiffe-peer-domain; required_count=12 ;;
  SourceTrustHistory.lean) suite=source-trust-history; required_count=25 ;;
  GuestContract.lean) suite=guest; required_count=27; extra=CustodyContract.lean ;;
  Invocation.lean) suite=invocation; required_count=4 ;;
  *) echo "unknown formal model: $model" >&2; exit 1 ;;
esac
obligations="$root/spec/formal/$suite/required-theorems.lean"
tmp="$(mktemp "${TMPDIR:-/tmp}/opensesame-axioms.XXXXXXXX.lean")"
output="$(mktemp "${TMPDIR:-/tmp}/opensesame-axioms.XXXXXXXX.out")"
trap 'rm -f "$tmp" "$output"' EXIT
# A suite may continue its model in one sibling file, checked as one model.
cat "$model" ${extra:+"${model%/*}/$extra"} "$root/spec/formal/required-theorem-command.lean" "$obligations" > "$tmp"
printf '\n#require_theorem_count %s\n' "$required_count" >> "$tmp"
cat >> "$tmp" <<'LEAN'

open Lean Elab Command
run_cmd do
  let env ← getEnv
  for (name, info) in env.constants.map₂.toList do
    match info with
    | .thmInfo _ =>
      let axioms ← Lean.collectAxioms name
      for ax in axioms do
        unless ax == ``propext || ax == ``Quot.sound do
          throwError "unapproved axiom {ax} in {name}"
    | .axiomInfo _ => throwError "unapproved axiom declaration {name}"
    | _ => pure ()
LEAN
if ! "$lean_bin" -DwarningAsError=true --run "$tmp" > "$output"; then
  cat "$output" >&2
  exit 1
fi
cat "$output"
