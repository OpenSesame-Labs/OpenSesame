//! Unit tests for the ACME DNS-01 client in [`super`].
//!
//! A sibling file so the module itself stays inside its recorded size budget.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use base64::prelude::{Engine, BASE64_URL_SAFE_NO_PAD};
use bytes::Bytes;
use http::{Method, Request, Response, StatusCode};
use http_body_util::BodyExt;
use instant_acme::{BodyWrapper, BytesResponse, HttpClient};
use rcgen::{
    BasicConstraints, CertificateParams, CertificateSigningRequestParams, DistinguishedName,
    DnType, IsCa, Issuer, KeyPair,
};

use super::super::model::{CertificateRequestInput, TrustClass};
use super::*;

#[derive(Default)]
struct MockDns {
    presented: Mutex<Vec<String>>,
    cleaned: Mutex<Vec<String>>,
    cleanup_fails: bool,
}

#[async_trait]
impl Dns01Provisioner for MockDns {
    type Lease = String;

    async fn present(&self, record: &Dns01Record) -> Result<Dns01Lease<Self::Lease>, Dns01Failure> {
        assert_eq!(record.name(), "_acme-challenge.example.test");
        assert!(!record.value().is_empty());
        self.presented
            .lock()
            .unwrap()
            .push(record.name().to_owned());
        Ok(Dns01Lease(record.name().to_owned()))
    }

    async fn cleanup(&self, lease: Dns01Lease<Self::Lease>) -> Result<(), Dns01Failure> {
        self.cleaned.lock().unwrap().push(lease.0);
        if self.cleanup_fails {
            Err(Dns01Failure::CleanupFailed)
        } else {
            Ok(())
        }
    }
}

struct MockAcmeHttp {
    ca: Arc<(rcgen::Certificate, KeyPair)>,
    issued_chain: Arc<Mutex<Option<String>>>,
}

impl MockAcmeHttp {
    fn new() -> Self {
        let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let mut params = CertificateParams::default();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.distinguished_name = DistinguishedName::new();
        params
            .distinguished_name
            .push(DnType::CommonName, "Mock ACME CA");
        let cert = params.self_signed(&key).unwrap();
        Self {
            ca: Arc::new((cert, key)),
            issued_chain: Arc::new(Mutex::new(None)),
        }
    }

    fn response(
        status: StatusCode,
        location: Option<&str>,
        body: impl Into<Vec<u8>>,
    ) -> BytesResponse {
        let mut builder = Response::builder()
            .status(status)
            .header("replay-nonce", uuid::Uuid::new_v4().to_string());
        if let Some(location) = location {
            builder = builder.header("location", location);
        }
        let response = builder.body(BodyWrapper::from(body.into())).unwrap();
        response.into()
    }
}

impl HttpClient for MockAcmeHttp {
    #[expect(
        clippy::excessive_nesting,
        reason = "the single match is a cohesive deterministic ACME protocol fixture"
    )]
    fn request(
        &self,
        mut request: Request<BodyWrapper<Bytes>>,
    ) -> Pin<Box<dyn Future<Output = Result<BytesResponse, instant_acme::Error>> + Send>> {
        let ca = self.ca.clone();
        let issued_chain = self.issued_chain.clone();
        Box::pin(async move {
            let path = request.uri().path().to_owned();
            let method = request.method().clone();
            let body = request
                .body_mut()
                .collect()
                .await
                .expect("infallible in-memory request body")
                .to_bytes();
            let response = match (method, path.as_str()) {
                (Method::GET, "/directory") => Self::response(
                    StatusCode::OK,
                    None,
                    br#"{"newNonce":"https://acme.test/nonce","newAccount":"https://acme.test/account","newOrder":"https://acme.test/new-order","revokeCert":"https://acme.test/revoke","keyChange":"https://acme.test/key-change","meta":{}}"#.to_vec(),
                ),
                (Method::HEAD, "/nonce") => Self::response(StatusCode::OK, None, Vec::new()),
                (Method::POST, "/account") => Self::response(
                    StatusCode::CREATED,
                    Some("https://acme.test/account/1"),
                    Vec::new(),
                ),
                (Method::POST, "/new-order") => Self::response(
                    StatusCode::CREATED,
                    Some("https://acme.test/order/1"),
                    br#"{"status":"pending","authorizations":["https://acme.test/authz/1"],"error":null,"finalize":"https://acme.test/finalize/1","certificate":null}"#.to_vec(),
                ),
                (Method::POST, "/authz/1") => Self::response(
                    StatusCode::OK,
                    None,
                    br#"{"identifier":{"type":"dns","value":"example.test"},"status":"pending","challenges":[{"type":"dns-01","url":"https://acme.test/challenge/1","token":"mock-token","status":"pending","error":null}],"wildcard":false}"#.to_vec(),
                ),
                (Method::POST, "/challenge/1") => Self::response(
                    StatusCode::OK,
                    None,
                    br#"{"type":"dns-01","url":"https://acme.test/challenge/1","token":"mock-token","status":"processing","error":null}"#.to_vec(),
                ),
                (Method::POST, "/order/1") => {
                    let certificate = issued_chain.lock().unwrap().is_some();
                    let body = if certificate {
                        br#"{"status":"valid","authorizations":["https://acme.test/authz/1"],"error":null,"finalize":"https://acme.test/finalize/1","certificate":"https://acme.test/cert/1"}"#.to_vec()
                    } else {
                        br#"{"status":"ready","authorizations":["https://acme.test/authz/1"],"error":null,"finalize":"https://acme.test/finalize/1","certificate":null}"#.to_vec()
                    };
                    Self::response(StatusCode::OK, None, body)
                }
                (Method::POST, "/finalize/1") => {
                    let jose: Value = serde_json::from_slice(&body).unwrap();
                    let payload = BASE64_URL_SAFE_NO_PAD
                        .decode(jose["payload"].as_str().unwrap())
                        .unwrap();
                    let finalize: Value = serde_json::from_slice(&payload).unwrap();
                    let csr = BASE64_URL_SAFE_NO_PAD
                        .decode(finalize["csr"].as_str().unwrap())
                        .unwrap();
                    let csr = CertificateSigningRequestParams::from_der(&csr.into()).unwrap();
                    let issuer =
                        Issuer::from_ca_cert_pem(&ca.0.pem(), &ca.1).unwrap();
                    let cert = csr.signed_by(&issuer).unwrap();
                    *issued_chain.lock().unwrap() = Some(format!("{}{}", cert.pem(), ca.0.pem()));
                    Self::response(
                        StatusCode::OK,
                        None,
                        br#"{"status":"processing","authorizations":["https://acme.test/authz/1"],"error":null,"finalize":"https://acme.test/finalize/1","certificate":null}"#.to_vec(),
                    )
                }
                (Method::POST, "/cert/1") => Self::response(
                    StatusCode::OK,
                    None,
                    issued_chain.lock().unwrap().clone().unwrap().into_bytes(),
                ),
                _ => panic!("unexpected mock ACME request: {path}"),
            };
            Ok(response)
        })
    }
}

#[tokio::test]
async fn contract_acme_dns01_uses_generated_key_and_cleans_up() {
    let http = Box::new(MockAcmeHttp::new());
    let (account, credentials) = AcmeAccount::create_with_builder(
        Account::builder_with_http(http),
        AcmeProvider::LetsEncrypt(AcmeEnvironment::Staging),
        &[],
        None,
    )
    .await
    .unwrap();
    assert!(credentials.as_bytes_for_sealing().len() > 32);
    assert!(!format!("{credentials:?}").contains("key_pkcs8"));

    let request =
        CertificateRequest::try_from(CertificateRequestInput::new("example.test")).unwrap();
    let dns = MockDns::default();
    let issued = account
        .issue_dns01(&request, ChallengeKind::Dns01, &dns)
        .await
        .unwrap();
    assert_eq!(issued.bundle().issuer, IssuerKind::LetsEncryptStaging);
    assert_eq!(issued.bundle().trust, TrustClass::TestOnly);
    assert_eq!(dns.presented.lock().unwrap().len(), 1);
    assert_eq!(dns.cleaned.lock().unwrap().len(), 1);
    assert!(issued.into_delivery().1.contains("BEGIN PRIVATE KEY"));
}

#[tokio::test]
async fn adversarial_acme_refuses_challenge_downgrade_before_network() {
    let http = Box::new(MockAcmeHttp::new());
    let (account, _) = AcmeAccount::create_with_builder(
        Account::builder_with_http(http),
        AcmeProvider::LetsEncrypt(AcmeEnvironment::Staging),
        &[],
        None,
    )
    .await
    .unwrap();
    let request =
        CertificateRequest::try_from(CertificateRequestInput::new("example.test")).unwrap();
    let error = account
        .issue_dns01(&request, ChallengeKind::Http01, &MockDns::default())
        .await
        .unwrap_err();
    assert_eq!(
        error,
        IssuerError::UnsupportedChallenge(ChallengeKind::Http01)
    );
}

#[tokio::test]
async fn chaos_acme_refuses_delivery_when_dns_cleanup_fails() {
    let (account, _) = AcmeAccount::create_with_builder(
        Account::builder_with_http(Box::new(MockAcmeHttp::new())),
        AcmeProvider::LetsEncrypt(AcmeEnvironment::Staging),
        &[],
        None,
    )
    .await
    .unwrap();
    let request =
        CertificateRequest::try_from(CertificateRequestInput::new("example.test")).unwrap();
    let dns = MockDns {
        cleanup_fails: true,
        ..MockDns::default()
    };
    assert_eq!(
        account
            .issue_dns01(&request, ChallengeKind::Dns01, &dns)
            .await
            .unwrap_err(),
        IssuerError::Dns01("cleanup")
    );
    assert_eq!(dns.cleaned.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn adversarial_acme_transport_refuses_endpoint_substitution() {
    let client =
        ReqwestAcmeHttp::new(AcmeProvider::LetsEncrypt(AcmeEnvironment::Production)).unwrap();
    let request = Request::builder()
        .uri("https://127.0.0.1/latest/meta-data")
        .body(BodyWrapper::default())
        .unwrap();
    assert!(HttpClient::request(&client, request).await.is_err());
}

#[test]
fn atomic_provider_profiles_are_exact_and_zero_ssl_requires_eab() {
    assert_eq!(
        AcmeProvider::LetsEncrypt(AcmeEnvironment::Production).directory_url(),
        "https://acme-v02.api.letsencrypt.org/directory"
    );
    assert_eq!(
        AcmeProvider::ZeroSsl.directory_url(),
        "https://acme.zerossl.com/v2/DV90"
    );
    assert_eq!(
        AcmeProvider::ZeroSsl.issuer().trust(),
        TrustClass::PublicWeb
    );
}
