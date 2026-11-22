//! GuestState fence tests: egress intersection and response caps.

use super::*;

struct NoEgress;
impl HostEgress for NoEgress {
    fn authorized_request(
        &self,
        _binding: &InvocationBinding,
        _connection_ref: &str,
        _req: EgressRequest,
    ) -> Result<EgressResponse, String> {
        Err("unreachable in this test".into())
    }
    fn sign(
        &self,
        _binding: &InvocationBinding,
        _purpose: &str,
        _digest: &[u8],
    ) -> Result<Vec<u8>, String> {
        Err("unreachable in this test".into())
    }
    fn oauth_acquire(
        &self,
        _binding: &InvocationBinding,
        _connection_ref: &str,
        _resource: Option<&str>,
        _audience: Option<&str>,
        _scopes: &[String],
    ) -> Result<u32, String> {
        Err("unreachable in this test".into())
    }
    fn authenticated_request(
        &self,
        _binding: &InvocationBinding,
        _connection_ref: &str,
        _token_handle: u32,
        _req: EgressRequest,
    ) -> Result<EgressResponse, String> {
        Err("unreachable in this test".into())
    }
}

fn state_with(outbound: &[&str], policy: HostPolicy) -> GuestState {
    GuestState {
        limits: StoreLimitsBuilder::new().build(),
        policy,
        outbound_hosts: outbound.iter().map(|h| (*h).to_owned()).collect(),
        connection_ref: "conn://test".into(),
        binding: None,
        issued_tokens: Vec::new(),
        egress: Arc::new(NoEgress),
        max_response_bytes: 1024,
    }
}

/// Egress is the *intersection* of `HostPolicy` and the manifest: a host
/// present in only one of the two is refused, and every refusal reads
/// the same — no oracle distinguishing which fence fired.
#[test]
fn guest_destination_requires_both_fences() {
    let policy = HostPolicy::default(); // allows api.github.com
    let both = state_with(&["api.github.com"], policy.clone());
    assert!(both
        .assert_guest_destination("https://api.github.com/repos")
        .is_ok());

    // In policy, not in the manifest.
    let manifest_missing = state_with(&["api.example.com"], policy.clone());
    assert_eq!(
        manifest_missing.assert_guest_destination("https://api.github.com/repos"),
        Err("destination denied".to_owned())
    );

    // In the manifest, not in policy.
    let policy_missing = state_with(&["api.example.com"], policy.clone());
    assert_eq!(
        policy_missing.assert_guest_destination("https://api.example.com/v1"),
        Err("destination denied".to_owned())
    );

    // SSRF fence still applies underneath both.
    let ssrf = state_with(&["169.254.169.254"], policy);
    assert_eq!(
        ssrf.assert_guest_destination("https://169.254.169.254/latest"),
        Err("destination denied".to_owned())
    );
}

#[test]
fn responses_are_capped() {
    let state = state_with(&[], HostPolicy::default());
    let resp = state.cap_response(EgressResponse {
        status: 200,
        headers: vec![],
        body: vec![0u8; 4096],
    });
    assert_eq!(resp.body.len(), 1024);
}
