use super::*;
use crate::binding_test_fixtures::{delegated, owner};
use opensesame_domain::InvocationId;
use std::sync::Mutex;

#[derive(Default)]
struct RecordingEgress(Mutex<Vec<(InvocationId, &'static str)>>);
impl RecordingEgress {
    fn record(&self, binding: &InvocationBinding, method: &'static str) {
        self.0
            .lock()
            .unwrap()
            .push((binding.invocation_id(), method));
    }
}
impl HostEgress for RecordingEgress {
    fn authorized_request(
        &self,
        binding: &InvocationBinding,
        _connection: &str,
        _req: EgressRequest,
    ) -> Result<EgressResponse, String> {
        self.record(binding, "http");
        Ok(EgressResponse {
            status: 200,
            headers: vec![],
            body: vec![],
        })
    }
    fn sign(
        &self,
        binding: &InvocationBinding,
        _purpose: &str,
        _digest: &[u8],
    ) -> Result<Vec<u8>, String> {
        self.record(binding, "sign");
        Ok(vec![])
    }
    fn oauth_acquire(
        &self,
        binding: &InvocationBinding,
        _connection: &str,
        _resource: Option<&str>,
        _audience: Option<&str>,
        _scopes: &[String],
    ) -> Result<u32, String> {
        self.record(binding, "acquire");
        Ok(7)
    }
    fn authenticated_request(
        &self,
        binding: &InvocationBinding,
        _connection: &str,
        _token: u32,
        _req: EgressRequest,
    ) -> Result<EgressResponse, String> {
        self.record(binding, "authenticated");
        Ok(EgressResponse {
            status: 200,
            headers: vec![],
            body: vec![],
        })
    }
}

fn state(binding: Option<InvocationBinding>, egress: Arc<RecordingEgress>) -> GuestState {
    GuestState {
        limits: StoreLimitsBuilder::new().build(),
        policy: HostPolicy::default(),
        outbound_hosts: ["api.github.com".to_owned()].into_iter().collect(),
        connection_ref: "demo-conn".into(),
        binding,
        issued_tokens: Vec::new(),
        egress,
        max_response_bytes: 1024,
    }
}

fn request() -> host_http::Request {
    host_http::Request {
        method: "GET".into(),
        url: "https://api.github.com/repos".into(),
        headers: vec![],
        body: vec![],
    }
}

fn exercise_all(state: &mut GuestState) -> [bool; 4] {
    [
        host_http::Host::authorized_request(state, Resource::new_own(0), request()).is_ok(),
        bindings::opensesame::connector::host_crypto::Host::sign(
            state,
            Resource::new_own(0),
            "repository.read".into(),
            vec![1],
        )
        .is_ok(),
        // acquire must name the bound resource and audience itself, and may
        // name no scopes: nothing in the binding pins any.
        host_oauth::Host::acquire(
            state,
            Resource::new_own(0),
            host_oauth::TokenRequest {
                resource: Some("repo:example/one".into()),
                audience: Some("https://api.github.com".into()),
                scopes: vec![],
            },
        )
        .is_ok(),
        host_oauth::Host::authenticated_request(
            state,
            Resource::new_own(0),
            Resource::new_own(7),
            request(),
        )
        .is_ok(),
    ]
}

#[test]
fn every_guest_egress_carries_its_own_invocation_binding() {
    let (intent, grant, _) = owner();
    let first = InvocationId::new();
    let second = InvocationId::new();
    let a = InvocationBinding::from_intent(first, &intent, &grant, "user:owner", "demo-conn", None)
        .unwrap();
    let b =
        InvocationBinding::from_intent(second, &intent, &grant, "user:owner", "demo-conn", None)
            .unwrap();
    let recorder = Arc::new(RecordingEgress::default());
    let mut first_state = state(Some(a), Arc::clone(&recorder));
    let mut second_state = state(Some(b), Arc::clone(&recorder));
    assert_eq!(exercise_all(&mut first_state), [true; 4]);
    assert_eq!(exercise_all(&mut second_state), [true; 4]);
    let seen = recorder.0.lock().unwrap();
    assert_eq!(
        &seen[..4],
        &[
            (first, "http"),
            (first, "sign"),
            (first, "acquire"),
            (first, "authenticated")
        ]
    );
    assert_eq!(
        &seen[4..],
        &[
            (second, "http"),
            (second, "sign"),
            (second, "acquire"),
            (second, "authenticated")
        ]
    );
}

#[test]
fn unbound_and_delegated_guest_egress_never_reaches_implementation() {
    let (intent, grant, _, chain) = delegated();
    let binding = InvocationBinding::from_intent(
        InvocationId::new(),
        &intent,
        &grant,
        "user:delegate",
        "demo-conn",
        Some(&chain),
    )
    .unwrap();
    let recorder = Arc::new(RecordingEgress::default());
    assert_eq!(
        exercise_all(&mut state(None, Arc::clone(&recorder))),
        [false; 4]
    );
    assert_eq!(
        exercise_all(&mut state(Some(binding), Arc::clone(&recorder))),
        [false; 4]
    );
    assert!(recorder.0.lock().unwrap().is_empty());
}

#[test]
fn guest_cannot_retarget_a_valid_binding_to_another_connection() {
    let (intent, grant, _) = owner();
    let binding = InvocationBinding::from_intent(
        InvocationId::new(),
        &intent,
        &grant,
        "user:owner",
        "demo-conn",
        None,
    )
    .unwrap();
    let recorder = Arc::new(RecordingEgress::default());
    let mut guest = state(Some(binding), Arc::clone(&recorder));
    guest.connection_ref = "other".into();
    assert_eq!(exercise_all(&mut guest), [false; 4]);
    assert!(recorder.0.lock().unwrap().is_empty());
}

#[test]
fn guest_cannot_substitute_method_url_headers_purpose_or_token_handle() {
    let (intent, grant, _) = owner();
    let binding = InvocationBinding::from_intent(
        InvocationId::new(),
        &intent,
        &grant,
        "user:owner",
        "demo-conn",
        None,
    )
    .unwrap();
    let recorder = Arc::new(RecordingEgress::default());
    let mut guest = state(Some(binding), Arc::clone(&recorder));

    let mut other_host = request();
    other_host.url = "https://evil.example/repos".into();
    assert!(
        host_http::Host::authorized_request(&mut guest, Resource::new_own(0), other_host).is_err()
    );

    let mut credential_header = request();
    credential_header.headers = vec![("Authorization".into(), "Bearer stolen".into())];
    assert!(host_http::Host::authorized_request(
        &mut guest,
        Resource::new_own(0),
        credential_header
    )
    .is_err());

    assert!(bindings::opensesame::connector::host_crypto::Host::sign(
        &mut guest,
        Resource::new_own(0),
        "other-purpose".into(),
        vec![1],
    )
    .is_err());

    let mut widened = host_oauth::TokenRequest {
        resource: Some("repo:example/two".into()),
        audience: Some("https://api.github.com".into()),
        scopes: vec![],
    };
    assert!(host_oauth::Host::acquire(&mut guest, Resource::new_own(0), widened).is_err());
    widened = host_oauth::TokenRequest {
        resource: Some("repo:example/one".into()),
        audience: Some("https://other.example".into()),
        scopes: vec![],
    };
    assert!(host_oauth::Host::acquire(&mut guest, Resource::new_own(0), widened).is_err());

    assert!(host_oauth::Host::authenticated_request(
        &mut guest,
        Resource::new_own(0),
        Resource::new_own(99),
        request(),
    )
    .is_err());
    assert!(recorder.0.lock().unwrap().is_empty());

    assert!(exercise_all(&mut guest) == [true; 4]);
    assert_eq!(recorder.0.lock().unwrap().len(), 4);
}

/// An omitted resource or audience is not "whatever the binding says": an
/// unnamed target is refused, and so is a guest-named scope, because nothing
/// in the binding pins one.
#[test]
fn acquire_must_name_the_bound_target_and_claim_no_scopes() {
    let (intent, grant, _) = owner();
    let binding = InvocationBinding::from_intent(
        InvocationId::new(),
        &intent,
        &grant,
        "user:owner",
        "demo-conn",
        None,
    )
    .unwrap();
    let mut guest = state(Some(binding), Arc::new(RecordingEgress::default()));
    for request in [
        host_oauth::TokenRequest {
            resource: None,
            audience: Some("https://api.github.com".into()),
            scopes: vec![],
        },
        host_oauth::TokenRequest {
            resource: Some("repo:example/one".into()),
            audience: None,
            scopes: vec![],
        },
        host_oauth::TokenRequest {
            resource: None,
            audience: None,
            scopes: vec![],
        },
        host_oauth::TokenRequest {
            resource: Some("repo:example/one".into()),
            audience: Some("https://api.github.com".into()),
            scopes: vec!["repo".into()],
        },
    ] {
        assert!(
            host_oauth::Host::acquire(&mut guest, Resource::new_own(0), request).is_err(),
            "unpinned token request must be refused"
        );
    }
}

/// Audience pinning fails closed on an unparsable audience and compares the
/// whole origin: a different port or userinfo is a different target.
#[test]
fn audience_pinning_fails_closed_and_compares_the_whole_origin() {
    fn guest_with_audience(audience: &str) -> GuestState {
        let (mut intent, grant, _) = owner();
        intent.audience = audience.into();
        let binding = InvocationBinding::from_intent(
            InvocationId::new(),
            &intent,
            &grant,
            "user:owner",
            "demo-conn",
            None,
        )
        .unwrap();
        state(Some(binding), Arc::new(RecordingEgress::default()))
    }

    // Same origin on the default port: admitted.
    let mut guest = guest_with_audience("https://api.github.com");
    assert!(
        host_http::Host::authorized_request(&mut guest, Resource::new_own(0), request()).is_ok()
    );

    // An explicit default port is the same origin.
    let mut guest = guest_with_audience("https://api.github.com:443");
    assert!(
        host_http::Host::authorized_request(&mut guest, Resource::new_own(0), request()).is_ok()
    );

    // A non-default port the intent never named is a different origin.
    let mut guest = guest_with_audience("https://api.github.com");
    let mut offport = request();
    offport.url = "https://api.github.com:8443/repos".into();
    assert!(
        host_http::Host::authorized_request(&mut guest, Resource::new_own(0), offport).is_err()
    );
    // The pin also refuses the mirror image: an audience pinned to an odd
    // port does not cover the default port. The destination fences pass this
    // URL; only the origin comparison refuses it.
    let mut guest = guest_with_audience("https://api.github.com:8443");
    assert!(
        host_http::Host::authorized_request(&mut guest, Resource::new_own(0), request()).is_err()
    );

    // Userinfo on the guest URL is a credential channel, not a target.
    let mut guest = guest_with_audience("https://api.github.com");
    let mut userinfo = request();
    userinfo.url = "https://token:secret@api.github.com/repos".into();
    assert!(
        host_http::Host::authorized_request(&mut guest, Resource::new_own(0), userinfo).is_err()
    );

    // A scheme change is a different origin.
    let mut guest = guest_with_audience("http://api.github.com");
    assert!(
        host_http::Host::authorized_request(&mut guest, Resource::new_own(0), request()).is_err()
    );

    // An audience that does not parse pins nothing and admits nothing.
    let mut guest = guest_with_audience("api.github.com");
    assert!(
        host_http::Host::authorized_request(&mut guest, Resource::new_own(0), request()).is_err()
    );
}
