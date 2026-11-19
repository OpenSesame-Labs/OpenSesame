#!/usr/bin/env bash
set -euo pipefail

suite="${1:-}"
log_dir="${PR_RUST_EVIDENCE_LOG_DIR:?missing PR_RUST_EVIDENCE_LOG_DIR}"
mkdir -p "$log_dir"

if [[ "$suite" != receipt-owner-mapping ]]; then
  echo "unsupported Rust security evidence suite" >&2
  exit 2
fi

rustc --version | tee "$log_dir/toolchain.log"
grep -Eq '^rustc 1\.99\.0([[:space:]]|$)' "$log_dir/toolchain.log"

run_case() {
  local label="$1"
  shift
  local log="$log_dir/$label.log"
  cargo test --locked "$@" -- --nocapture 2>&1 | tee "$log"
  grep -Eq 'test result: ok\. [1-9][0-9]* passed;' "$log"
}

run_case domain -p opensesame-domain --lib
run_case audit -p opensesame-audit --lib
run_case storage-lib -p opensesame-storage --lib
run_case storage-certmgr -p opensesame-storage --test certmgr_pact
run_case storage-est-budget -p opensesame-storage --test est_passphrase_budget
run_case broker-lib -p opensesame-broker --lib
run_case broker-adversarial -p opensesame-broker --test adversarial_broker
run_case connection-broker -p opensesame-connection-broker --lib
run_case connector-host -p opensesame-connector-host --features wasm-connectors
run_case invoke-through -p opensesame-invoke-through
run_case gateway-lib -p opensesame-gateway --lib --features wasm-connectors,testkit
run_case gateway-testkit -p opensesame-gateway --test testkit --features testkit
