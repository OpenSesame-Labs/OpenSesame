use super::{ensure_refusal, policy, EnsureBody};
use std::cell::Cell;

#[test]
fn provenance_restriction_is_reported_and_old_denials_still_work() {
    let policy = policy();
    let blocked: EnsureBody = serde_json::from_str(
        r#"{"status":"denied","reason":"authenticator_provenance_unavailable"}"#,
    )
    .unwrap();
    assert_eq!(
        ensure_refusal(&blocked, &policy),
        Some(policy.messages.blocked_approval.as_str())
    );
    let legacy: EnsureBody = serde_json::from_str(r#"{"status":"denied"}"#).unwrap();
    assert_eq!(
        ensure_refusal(&legacy, &policy),
        Some(super::denied_message())
    );
    let pending: EnsureBody = serde_json::from_str(r#"{"status":"pending"}"#).unwrap();
    assert_eq!(ensure_refusal(&pending, &policy), None);
}

#[test]
fn old_daemon_approval_cannot_bypass_the_local_pause() {
    for verb in [
        "read",
        "reveal",
        "env-resolve",
        "run",
        "pass-reveal",
        "unknown",
    ] {
        let called = Cell::new(false);
        let outcome = super::with_available_approval(verb, || {
            called.set(true);
            Ok(()) // An old daemon would have returned approved.
        });
        assert_eq!(
            outcome.unwrap_err().to_string(),
            policy().messages.blocked_approval
        );
        assert!(!called.get(), "daemon called for {verb}");
        assert!(super::ensure_reveal(verb, None).is_err());
    }
}
