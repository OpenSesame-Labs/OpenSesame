use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use super::*;
use crate::{EgressFence, RequestSigner, SignableParts};

fn rule(auth: AuthStyle) -> EgressRule {
    EgressRule {
        provider_id: "github",
        scheme: "https",
        hosts: &["localhost", "127.0.0.1"],
        auth,
    }
}

fn request(url: &str) -> InvokeRequest {
    InvokeRequest {
        provider_id: "github".into(),
        method: "GET".into(),
        url: url.into(),
        headers: vec![],
        body: None,
        subject: None,
        actor: None,
    }
}

#[tokio::test]
async fn requests_from_another_fence_cannot_escape_host_or_port() {
    let rules = vec![rule(AuthStyle::Bearer)];
    let fence = EgressFence::new(rules.clone(), DEFAULT_REQUEST_BODY_CAP).allow_http_for_tests();
    let invoker = Invoker::with_pinned(rules, "localhost", &["127.0.0.2:4321".parse().unwrap()])
        .allow_http_for_tests();
    for url in ["http://127.0.0.1:4321/", "http://localhost:4322/"] {
        let prepared = fence.preflight(request(url)).unwrap();
        assert!(matches!(
            invoker
                .execute(&SecretString::from("canary"), prepared)
                .await,
            Err(InvokeError::EgressDenied { .. })
        ));
        assert!(invoker.preflight(request(url)).is_err());
    }
}

#[test]
fn literal_ip_must_be_one_of_the_pinned_addresses() {
    let invoker = Invoker::with_pinned(
        vec![rule(AuthStyle::Bearer)],
        "127.0.0.1",
        &["127.0.0.2:4321".parse().unwrap()],
    )
    .allow_http_for_tests();
    assert!(invoker
        .preflight(request("http://127.0.0.1:4321/"))
        .is_err());
}

#[test]
fn injected_tls_enforces_the_same_scope() {
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(rustls::RootCertStore::empty())
    .with_no_client_auth();
    let spec = TlsClientSpec {
        config: Arc::new(config),
        server_name: None,
        pinned: Some(("localhost".into(), vec!["127.0.0.2:443".parse().unwrap()])),
    };
    let invoker = Invoker::with_tls(vec![rule(AuthStyle::Bearer)], &spec);
    assert!(invoker.preflight(request("https://127.0.0.1/")).is_err());
    assert!(invoker.preflight(request("https://localhost/")).is_ok());
}

struct CountingSigner(AtomicUsize);

impl RequestSigner for CountingSigner {
    fn sign(&self, _parts: &SignableParts<'_>) -> Result<Vec<(String, String)>, InvokeError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(vec![])
    }

    fn reflection_secrets(&self) -> Vec<&SecretString> {
        vec![]
    }
}

#[tokio::test]
async fn signed_requests_are_checked_before_invoking_the_signer() {
    let rules = vec![rule(AuthStyle::SigV4)];
    let fence = EgressFence::new(rules.clone(), DEFAULT_REQUEST_BODY_CAP).allow_http_for_tests();
    let invoker = Invoker::with_pinned(rules, "localhost", &["127.0.0.2:4321".parse().unwrap()])
        .allow_http_for_tests();
    let signer = CountingSigner(AtomicUsize::new(0));
    let prepared = fence.preflight(request("http://localhost:4322/")).unwrap();
    assert!(matches!(
        invoker.execute_signed(&signer, prepared).await,
        Err(InvokeError::EgressDenied { .. })
    ));
    assert_eq!(signer.0.load(Ordering::SeqCst), 0);
}
