//! Unit tests for the certificate issuance model in [`super`].
//!
//! A sibling file so the module itself stays inside its recorded size budget.

use super::*;
use proptest::prelude::*;
use rcgen::Issuer;

fn externally_signed_leaf(request: &CertificateRequest) -> (String, GeneratedLeafRequest) {
    let ca_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
    let mut ca_params = CertificateParams::default();
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let leaf = GeneratedLeafRequest::generate(request).unwrap();
    let csr = rcgen::CertificateSigningRequestParams::from_pem(leaf.csr_pem()).unwrap();
    let issuer = Issuer::from_ca_cert_pem(&ca.pem(), &ca_key).unwrap();
    (csr.signed_by(&issuer).unwrap().pem(), leaf)
}

proptest! {
    #[test]
    fn property_certificate_request_parser_is_bounded_and_never_panics(
        common_name in ".{0,512}",
        dns_names in proptest::collection::vec(".{0,300}", 0..120),
    ) {
        let result = CertificateRequest::try_from(CertificateRequestInput {
            common_name,
            dns_names,
            ip_addrs: Vec::new(),
            ttl: None,
        });
        if let Ok(request) = result {
            prop_assert!(request.dns_names().len() <= 100);
            prop_assert!(request.dns_names().iter().all(|name| name.len() <= 253));
        }
    }
}

#[test]
fn atomic_request_validation_normalizes_and_deduplicates_names() {
    let request = CertificateRequest::try_from(CertificateRequestInput {
        common_name: " Example.COM ".into(),
        dns_names: vec!["api.example.com".into(), "EXAMPLE.com".into()],
        ip_addrs: vec![],
        ttl: None,
    })
    .unwrap();
    assert_eq!(request.common_name(), "example.com");
    assert_eq!(request.dns_names(), &["api.example.com", "example.com"]);
    assert_eq!(request.ttl(), DEFAULT_TTL);
}

#[test]
fn contract_request_limits_are_exact_and_include_the_common_name() {
    assert_eq!(DEFAULT_TTL, Duration::from_secs(86_400));
    assert_eq!(MAX_TTL, Duration::from_secs(7_776_000));
    assert_eq!(MAX_CERTIFICATE_CHAIN_BYTES, 262_144);

    let accepted = CertificateRequest::try_from(CertificateRequestInput {
        common_name: "example.com".into(),
        dns_names: (0..99)
            .map(|index| format!("n{index}.example.com"))
            .collect(),
        ip_addrs: (1..=16)
            .map(|last| IpAddr::from([192, 0, 2, last]))
            .collect(),
        ttl: Some(MAX_TTL),
    })
    .unwrap();
    assert_eq!(accepted.dns_names().len(), 100);
    assert_eq!(accepted.ip_addrs().len(), 16);
    assert_eq!(accepted.ttl(), MAX_TTL);

    let too_many_dns = CertificateRequestInput {
        common_name: "example.com".into(),
        dns_names: (0..100)
            .map(|index| format!("n{index}.example.com"))
            .collect(),
        ip_addrs: Vec::new(),
        ttl: None,
    };
    assert_eq!(
        CertificateRequest::try_from(too_many_dns),
        Err(IssuerError::TooManyDnsNames)
    );

    let mut too_many_ips = CertificateRequestInput::new("example.com");
    too_many_ips.ip_addrs = (1..=17)
        .map(|last| IpAddr::from([192, 0, 2, last]))
        .collect();
    assert_eq!(
        CertificateRequest::try_from(too_many_ips),
        Err(IssuerError::TooManyIpAddresses)
    );

    for ttl in [Duration::ZERO, MAX_TTL + Duration::from_secs(1)] {
        let mut input = CertificateRequestInput::new("example.com");
        input.ttl = Some(ttl);
        assert_eq!(
            CertificateRequest::try_from(input),
            Err(IssuerError::InvalidTtl)
        );
    }
}

#[test]
fn contract_external_certificate_size_limit_is_exact() {
    let request =
        CertificateRequest::try_from(CertificateRequestInput::new("example.com")).unwrap();
    let (certificate, leaf) = externally_signed_leaf(&request);
    let exact = format!(
        "{certificate}{}",
        " ".repeat(MAX_CERTIFICATE_CHAIN_BYTES - certificate.len())
    );
    assert!(normalize_external_certificate(
        exact,
        leaf,
        &request,
        IssuerKind::CloudflareOriginCa,
        false,
    )
    .is_ok());

    let (certificate, leaf) = externally_signed_leaf(&request);
    let oversized = format!(
        "{certificate}{}",
        " ".repeat(MAX_CERTIFICATE_CHAIN_BYTES + 1 - certificate.len())
    );
    assert_eq!(
        normalize_external_certificate(
            oversized,
            leaf,
            &request,
            IssuerKind::CloudflareOriginCa,
            false,
        )
        .unwrap_err(),
        IssuerError::InvalidCertificateResponse
    );

    let (certificate, leaf) = externally_signed_leaf(&request);
    assert_eq!(
        normalize_external_certificate(certificate, leaf, &request, IssuerKind::LetsEncrypt, true,)
            .unwrap_err(),
        IssuerError::InvalidCertificateResponse
    );

    let (certificate, leaf) = externally_signed_leaf(&request);
    let substituted_request =
        CertificateRequest::try_from(CertificateRequestInput::new("substituted.example.com"))
            .unwrap();
    assert_eq!(
        normalize_external_certificate(
            certificate,
            leaf,
            &substituted_request,
            IssuerKind::CloudflareOriginCa,
            false,
        )
        .unwrap_err(),
        IssuerError::CertificateNamesMismatch
    );
}

#[test]
fn adversarial_request_rejects_ambiguous_names_and_unsupported_challenges() {
    for name in [
        "",
        ".example.com",
        "example.com.",
        "a..example.com",
        "a_1.example.com",
        "-a.example.com",
        "a-.example.com",
        "*.*.example.com",
        "café.example.com",
        &format!(
            "{}.{}.{}.{}",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(62)
        ),
        &format!("{}.example.com", "a".repeat(64)),
    ] {
        assert_eq!(
            CertificateRequest::try_from(CertificateRequestInput::new(name)).unwrap_err(),
            IssuerError::InvalidDnsName
        );
    }

    let maximum_name = format!(
        "{}.{}.{}.{}",
        "a".repeat(63),
        "b".repeat(63),
        "c".repeat(63),
        "d".repeat(61)
    );
    assert_eq!(maximum_name.len(), 253);
    assert!(CertificateRequest::try_from(CertificateRequestInput::new(maximum_name)).is_ok());
    assert_eq!(
        ChallengeKind::Http01.require_dns01().unwrap_err(),
        IssuerError::UnsupportedChallenge(ChallengeKind::Http01)
    );
    assert_eq!(
        ChallengeKind::TlsAlpn01.require_dns01().unwrap_err(),
        IssuerError::UnsupportedChallenge(ChallengeKind::TlsAlpn01)
    );
}

#[test]
fn adversarial_public_ca_rejects_local_and_ip_requests() {
    let local = CertificateRequest::try_from(CertificateRequestInput::new("localhost")).unwrap();
    assert_eq!(
        local.require_public_dns(),
        Err(IssuerError::PublicDnsRequired)
    );

    let single_label =
        CertificateRequest::try_from(CertificateRequestInput::new("intranet")).unwrap();
    assert_eq!(
        single_label.require_public_dns(),
        Err(IssuerError::PublicDnsRequired)
    );

    let mut input = CertificateRequestInput::new("example.com");
    input.ip_addrs.push("127.0.0.1".parse().unwrap());
    let request = CertificateRequest::try_from(input).unwrap();
    assert_eq!(
        request.require_public_dns(),
        Err(IssuerError::PublicDnsRequired)
    );
}

#[test]
fn secrets_are_redacted_and_leaf_key_delivery_is_consuming() {
    let request =
        CertificateRequest::try_from(CertificateRequestInput::new("example.com")).unwrap();
    let leaf = GeneratedLeafRequest::generate(&request).unwrap();
    let debug = format!("{leaf:?}");
    assert!(debug.contains("[REDACTED]"));
    assert!(!debug.contains("BEGIN PRIVATE KEY"));
    assert!(leaf.csr_pem().contains("BEGIN CERTIFICATE REQUEST"));
    assert!(leaf.into_private_key().contains("BEGIN PRIVATE KEY"));

    let issued = IssuedCertificate::new(
        CertificateBundle {
            certificate_chain_pem: "certificate".into(),
            issuer_certificate_pem: None,
            issuer: IssuerKind::OpenSesamePrivateCa,
            trust: TrustClass::PrivateLocal,
            common_name: "example.com".into(),
            dns_names: vec!["example.com".into()],
        },
        Zeroizing::new("issued-private-key".into()),
    );
    let debug = format!("{issued:?}");
    assert!(debug.contains("IssuedCertificate"));
    assert!(debug.contains("[REDACTED]"));
    assert!(!debug.contains("issued-private-key"));
}
