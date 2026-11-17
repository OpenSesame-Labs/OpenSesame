---
name: verify-formal-daemon-fill
description: "Check daemon fill routes refuse unpaired or unapproved callers. Use when changing paired_caller or fill approvals."
---

# Verify daemon fill pairing

`fill_value` returns `approval_required` unless `paired_caller` succeeds and approvals admit the origin.

Replay: `crates/daemon/src/fill/auth_tests.rs` (`approval_required` without pairing).

Model: `spec/formal-verification/daemon-fill-pairing/DaemonFillPairing.tla` (`NoFillWithoutPairing`).

**Property:** Fill RPCs refuse tokens that are not paired for the caller origin.

**Harm:** An unpaired token could exfiltrate sealed-store fill material across origins.

**Scratch-break:** `cargo test -p opensesame-daemon an_unpaired_token_is_refused` after commenting the pairing check in `crates/daemon/src/fill/caller.rs`, or run `node scripts/formal-scratch-break-four.mjs` when `libdbus-1-dev` is available. Log target: `/opt/cursor/artifacts/formal-scratch-breaks/daemon-fill-pairing.log`.