#!/usr/bin/env bash
# INV-I1, INV-O1, INV-O2, INV-D1, INV-D2: Lean decides every case; the real
# broker, connector host, connection broker and gateway replay each one.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
lean_bin="${OPENSESAME_LEAN_BIN:-lean}"
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--negative-controls" ) ]]; then
  echo "usage: $0 [--negative-controls]" >&2
  exit 2
fi
if ! command -v "$lean_bin" >/dev/null 2>&1 || [[ "$("$lean_bin" --version)" != "Lean (version 4.24.0,"* ]]; then
  echo "invocation-formal: Lean 4.24.0 is required" >&2
  exit 1
fi
drift() {
  python3 -I - "$1" <<'PY'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
sys.path.insert(0, str(root / "scripts" / "security"))
from formal_coverage_drift import assert_reviewed_revision_on_main, assert_worktree_sources
coverage = json.loads((root / "spec/formal/invocation/coverage.json").read_text())
if coverage.get("version") != 1 or not coverage.get("sources"):
    raise SystemExit("invocation-formal: invalid covered-source manifest")
assert_reviewed_revision_on_main(root, str(coverage.get("reviewed_revision", "")), "invocation-formal")
assert_worktree_sources(root, coverage["sources"], "invocation-formal")
print("invocation-formal: covered sources match coverage.json")
PY
}
scratch="$(mktemp -d "${TMPDIR:-/tmp}/opensesame-invocation-formal.XXXXXXXX")"
trap 'git -C "$root" worktree remove --force "$scratch/tree" >/dev/null 2>&1 || true; rm -rf "$scratch"' EXIT
vectors="$scratch/vectors.tsv"
retries="$scratch/retries.tsv"
drift "$root"
bash "$root/spec/formal/check-axioms.sh" "$lean_bin" "$root/spec/formal/invocation/Invocation.lean" > "$vectors"
grep -E $'^(invoke|replay)\t' "$vectors" > "$retries"
# Each harness is one ignored test that reads the vectors and fails with a
# `vector:` assertion; `1 passed` rules out a filter that selected nothing.
# The gateway harnesses share one build, with the Wasm registration capture.
gateway=(-p opensesame-gateway --features wasm-connectors --lib -- --ignored --exact)
harness() {
  local test
  case "$1" in
    retry) test=(-p opensesame-broker --test adversarial_broker -- --ignored --exact
      invocation_binding_tests::lean_retry_vectors_match_the_broker) ;;
    receipt) test=(-p opensesame-broker --test adversarial_broker -- --ignored --exact
      outcome_indeterminate_tests::lean_receipt_vectors_match_the_broker) ;;
    frozen) test=(-p opensesame-broker --lib -- --ignored --exact
      frozen::outcome_tests::lean_frozen_receipt_vectors_match_the_broker) ;;
    dispatch) test=(-p opensesame-connector-host --lib -- --ignored --exact
      invocation_binding::tests::lean_dispatch_vectors_match_the_host) ;;
    egress) test=(-p opensesame-connection-broker --lib -- --ignored --exact
      tests::owner_egress_vectors::lean_owner_egress_vectors_match_the_broker) ;;
    reject) test=(-p opensesame-broker --test adversarial_broker -- --ignored --exact
      invocation_binding_tests::lean_reject_delegated_vectors_match_the_broker) ;;
    admission) test=("${gateway[@]}"
      routes::intents::delegated_invoke_tests::effect_fence_tests::lean_effect_admission_vectors_match_the_gateway) ;;
    recovery) test=("${gateway[@]}"
      routes::tasks::bootstrap_tests::lean_recovery_vectors_match_the_gateway) ;;
    registration) test=("${gateway[@]}"
      connector_egress::binding_tests::lean_registration_vectors_match_the_gateway) ;;
    *) echo "invocation-formal: unknown harness $1" >&2; return 2 ;;
  esac
  (cd "$2" && OPENSESAME_INVOCATION_VECTORS="$retries" OPENSESAME_INVOCATION_EFFECT_VECTORS="$vectors" \
    CARGO_TARGET_DIR="$3" cargo test --locked "${test[@]}" --nocapture) > "$4" 2>&1 || return 1
  grep -q 'test result: ok. 1 passed' "$4"
}
for name in retry receipt frozen dispatch egress reject admission recovery registration; do
  if ! harness "$name" "$root" "${CARGO_TARGET_DIR:-$scratch/target}" "$scratch/$name.log"; then
    tail -40 "$scratch/$name.log" >&2
    echo "invocation-formal: $name correspondence failed" >&2
    exit 1
  fi
  grep -h '^invocation-formal:' "$scratch/$name.log" || echo "invocation-formal: $name vectors matched"
done
drift "$root"
if [[ "${1:-}" == "--negative-controls" ]]; then
  # Mutants are built in a detached worktree of HEAD; the checkout is untouched.
  if [[ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]]; then
    echo "invocation-formal: negative controls need a clean worktree" >&2
    exit 1
  fi
  git -C "$root" worktree add --quiet --detach "$scratch/tree" HEAD
  b=crates/broker/src c=crates/connector-host/src e=crates/connection-broker/src/egress_json.rs
  r=crates/domain/src/receipt.rs a=crates/audit/src/lib.rs
  o=crates/gateway/src/routes/tasks_opening.rs f=crates/gateway/src/routes/intents_budget.rs
  w=crates/gateway/src/connector_egress.rs
  # file@before@after@name@harness[@occurrence]; `\n` in before/after is a newline.
  controls=(
    "$b/idempotency.rs@existing.fingerprint.as_ref() == Some(fingerprint),@true,@fingerprint@retry"
    "$b/idempotency.rs@&& self.signer.verify_receipt(&receipt).is_ok()@@signature@retry"
    "$b/idempotency.rs@receipt.has_opaque_result()@true@opaque@retry"
    "$b/idempotency.rs@&& receipt.intent_digest == intent_commitment@@intent@retry"
    "$b/idempotency.rs@&& receipt.idempotency_binding.as_deref() == Some(commitment.as_str()),@,@binding@retry"
    "$b/lib.rs@                decision.decision,@                true,@policy@retry"
    "$b/lib.rs@            !replay_only,@            true,@replay@retry"
    "$b/lib.rs@let outcome = if disclose_outcome {@let outcome = if true {@o1-invoke-disclosure@receipt"
    "$b/independent_executor.rs@            false,\n            false,\n            true,@            false,\n            true,\n            true,@o1-independent-disclosure@receipt"
    "$c/builtin_connector.rs@str) -> bool {\n        self.is_inert_builtin_mock(connection_id)@str) -> bool {\n        !connection_id.is_empty()@o1-host-disclosure@receipt"
    "$b/lib.rs@            external_request_digest: None,@            external_request_digest: Some(\"sha256:provider\".into()),@o1-provider-digest@receipt"
    "$b/frozen.rs@.permits_outcome_disclosure(&input.connection_policy_id)@.permits_outcome_disclosure(&input.connection_policy_id)\n            || true@o1-frozen-disclosure@frozen"
    "$r@            && self.safe_result_summary.is_none()\n@@o1-opaque-summary@receipt"
    "$r@            && is_sha256_digest(&self.intent_digest)\n@@o1-opaque-digest@receipt"
    "$r@        self.receipt_schema_version == OPAQUE_RESULT_RECEIPT_SCHEMA_VERSION\n            && receipt_intent_commitment@        true\n            && receipt_intent_commitment@o2-opening-schema@receipt"
    "$a@        self.verify_receipt(receipt)?;\n        if !receipt.has_opaque_result()@        if !receipt.has_opaque_result()@o2-open-verify@receipt"
    "$a@        if !receipt.has_opaque_result() {\n            return Err(DomainError::Canonicalization(\n                \"receipt intent opening@        if false {\n            return Err(DomainError::Canonicalization(\n                \"receipt intent opening@o2-open-opaque@receipt"
    "$c/invocation_binding.rs@            || request.resource != self.intent.resource\n@@d1-resource@dispatch"
    "$c/invocation_binding.rs@            || actual_digest != self.intent.parameters_digest\n@@d1-parameters@dispatch"
    "$c/invocation_binding.rs@            || request.invoke_level != Some(1)\n@@d1-level@dispatch"
    "$c/invocation_binding.rs@        if intent.organization_id != grant.organization_id\n            ||@        if@d1-organization@dispatch"
    "$c/invocation_dispatch.rs@if binding.is_delegated() && !self.is_inert_builtin_mock(connection_id) {@if false {@d1-delegated@dispatch"
    "$c/invocation_dispatch.rs@            None => Err(HostError::InvocationBindingMismatch),@            None => connector.invoke(req),@d1-unbound@dispatch"
    "$e@            || row.provider_id != expected.provider_id\n@@d2-json-provider@egress@1"
    "$e@            || row.provider_id != expected.provider_id\n@@d2-http-provider@egress@2"
    "$e@            || row.owner_subject.as_deref() != Some(expected.owner_subject)\n@@d2-json-owner@egress@1"
    "$e@            || expected.grant.parent_grant_id.is_some()\n@@d2-json-child@egress@1"
    "$e@            || expected.grant.delegation_depth != 0\n@@d2-http-depth@egress@2"
    "$e@            || expected.grant.assert_active(Utc::now()).is_err()\n@@d2-http-active@egress@2"
    "$e@            || grant_connection.as_deref() != Some(expected.connection_id)\n@@d2-json-connection@egress@1"
    "$e@            || expected.grant.organization_id != *expected.organization_id\n@@d2-http-organization@egress@2"
    "$e@        if stored.as_ref() != Some(expected.grant) {@        if false {@d2-json-stored@egress@1"
    "$e@        if stored.as_ref() != Some(expected.grant) {@        if false {@d2-http-stored@egress@2"
    "$e@        if row.status == ConnectionStatus::Revoked {@        if false {@d2-row-revoked@egress"
    "$b/lib.rs@            if reject_delegated && auth.is_delegated() {@            if false {@d1-reject-delegated@reject"
    "$b/independent_executor.rs@            false,\n            false,\n            true,@            false,\n            false,\n            false,@d1-reject-independent@reject"
    "$o@Ok(intent) if intent.intent_digest == request.intent_digest => intent,@Ok(intent) => intent,@o2-recover-digest@recovery"
    "$o@    if wire.get(\"intent\") != Some(&canonical) {@    if false {@o2-recover-canonical@recovery"
    "$o@ || !caller.in_organization(&intent.organization_id)@@o2-recover-organization@recovery"
    "$o@!caller.owns(&intent.principal_id) || @@o2-recover-owner@recovery"
    "$f@let consistent = delegated == resolved.lineage.is_some()\n        &&@let consistent =@d1-admit-lineage@admission"
    "$f@        && delegated == child\n@@d1-admit-child@admission"
    "$f@        && (!delegated || resolved.broker_connection);@;@d1-admit-broker@admission"
    "$f@ || resolved.grant.delegation_depth > 0;@;@d1-admit-depth@admission"
    "$f@let inert_mock = !independent_executor\n        && st@let inert_mock = st@d1-admit-independent@admission"
    "$f@(!delegated || replay_only || inert_mock)@(!delegated || inert_mock)@d1-admit-replay@admission"
    "$f@(!delegated || replay_only || inert_mock)@(!delegated || replay_only)@d1-admit-mock@admission"
    "$f@    if consistent && (@    if (@d1-admit-consistent@admission"
    "$w@        if binding.is_delegated()\n            ||@        if@d2-capture-delegated@registration"
    "$w@            || binding.connection_policy_id() != connection_ref\n@@d2-capture-policy@registration"
    "$w@            || registered_provider != connection_ref\n@@d2-capture-provider@registration"
    "$w@            || binding.grant().connection_id != Some(connection)\n@@d2-capture-grant-connection@registration"
    "$w@            || binding.grant().assert_active(Utc::now()).is_err()\n@@d2-capture-active@registration"
    "$w@accepts_binding(binding, connection_ref, &self.registered_provider)@binding.connection_id()@d2-bridge-capture@registration"
  )
  for control in "${controls[@]}"; do
    IFS='@' read -r file before after name runner occurrence <<<"$control"
    python3 -I - "$scratch/tree/$file" "$before" "$after" "${occurrence:-}" <<'PY'
import sys
path, before, after, occurrence = sys.argv[1:]
before, after = before.replace("\\n", "\n"), after.replace("\\n", "\n")
text = open(path).read()
count = text.count(before)
if (count != 1) if not occurrence else (count < 2 or int(occurrence) > count):
    raise SystemExit(f"mutation target must occur once, or name its occurrence: {before}")
index = -1
for _ in range(int(occurrence or 1)):
    index = text.index(before, index + 1)
open(path, "w").write(text[:index] + after + text[index + len(before):])
PY
    if harness "$runner" "$scratch/tree" "${CARGO_TARGET_DIR:-$scratch/target}" "$scratch/$name.log"; then
      echo "invocation-formal: negative control was not detected: $name" >&2
      exit 1
    fi
    if ! grep -q 'vector:' "$scratch/$name.log"; then
      echo "invocation-formal: $name failed without a correspondence assertion" >&2
      tail -20 "$scratch/$name.log" >&2
      exit 1
    fi
    git -C "$scratch/tree" checkout --quiet -- "$file"
    echo "invocation-formal: detected negative control $name"
  done
fi
