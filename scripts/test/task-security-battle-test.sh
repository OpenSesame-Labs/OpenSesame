#!/usr/bin/env bash
# Task-scoped authority battle tests (no cloud credentials).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "== domain / proof / task-access / protocol / broker =="
cargo test -p opensesame-domain -p opensesame-proof -p opensesame-task-access \
  -p opensesame-protocol-mcp -p opensesame-broker --quiet

echo "== aauth experimental adapter =="
cargo test -p opensesame-protocol-aauth --features experimental-aauth --quiet

echo "== gateway compiles with task routes =="
cargo check -p opensesame-gateway --quiet

echo "== cli + proof + task-access =="
cargo test -p opensesame-proof -p opensesame-task-access -p opensesame-cli --quiet

echo "== mcp-host =="
npm run test -w @opensesame/mcp-host

echo "task-security-battle-test: OK"
