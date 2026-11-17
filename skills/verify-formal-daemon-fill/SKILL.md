---
name: verify-formal-daemon-fill
description: "Check daemon fill routes refuse unpaired or unapproved callers. Use when changing paired_caller or fill approvals."
---

# Verify daemon fill pairing

`fill_value` returns `approval_required` unless `paired_caller` succeeds and approvals admit the origin.

Replay: `crates/daemon/src/fill/auth_tests.rs` (`approval_required` without pairing).

Model: `spec/formal-verification/daemon-fill-pairing/DaemonFillPairing.tla` (`NoFillWithoutPairing`).