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
            "test".into(),
            vec![1],
        )
        .is_ok(),
        host_oauth::Host::acquire(
            state,
            Resource::new_own(0),
            host_oauth::TokenRequest {
                resource: None,
                audience: None,
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
