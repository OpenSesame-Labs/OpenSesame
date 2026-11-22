//! Paused approvals cannot inherit a pending request or an approved session.

use crate::test_support::{ensure_params_full, mint_test_human_proof, test_paired_binding};
use crate::{ApprovedSession, CliAppIntegrationStore, PendingRequest};

#[test]
fn every_verb_is_denied_before_pending_coalescing_or_session_reuse() {
    let mut store = CliAppIntegrationStore::new();
    store.set_now_ms(1_000);
    let terminal = "term-a";
    store.approved.insert(
        terminal.into(),
        ApprovedSession {
            approved_at_ms: 1_000,
            last_activity_ms: 1_000,
        },
    );
    store.pending.insert(
        "existing".into(),
        PendingRequest {
            request_id: "existing".into(),
            terminal_session_id: terminal.into(),
            verb: "reveal".into(),
            reference: None,
            created_at_ms: 1_000,
            respond_nonce: "nonce".into(),
            argv_hash: "00".into(),
            peer_pid: 42,
            peer_start_time: 7,
            approvable: true,
        },
    );
    for verb in [
        "run",
        "pass-reveal",
        "read",
        "reveal",
        "env-resolve",
        "unknown",
    ] {
        for reuse in [false, true] {
            let params = ensure_params_full(terminal, verb, reuse, "00", 42, 7, true);
            assert_eq!(store.ensure(params), ("denied".into(), None));
        }
    }
    assert_eq!(store.list_pending().len(), 1);
    let proof = mint_test_human_proof("existing", terminal, "nonce", "reveal", 42, 7);
    assert_eq!(
        store
            .approve(
                "existing",
                terminal,
                "nonce",
                &proof,
                &test_paired_binding()
            )
            .0,
        "wrongSession"
    );
    assert_eq!(store.list_pending().len(), 1);
}
