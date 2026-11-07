//! Frozen DER for the OCSP messages this crate encodes by hand.
//!
//! The request and response structures are derived over the `der` crate, not
//! built by rcgen, so an upgrade of `der`, `spki` or `x509-cert` is exactly the
//! change that could alter a tag, a length or an optional field on the wire.
//! The responder signs with Ed25519, which is deterministic, so every byte of a
//! response is a function of the fixed inputs below. A failure here does not
//! mean "update the digest" — it means relying parties would see a different
//! response for the same facts.

use base64::Engine as _;
use opensesame_pki_core::keys;
use opensesame_pki_core::revocation::{
    build_ocsp_request, build_ocsp_response, parse_ocsp_request, parse_ocsp_response,
    OcspCertStatus, OcspRequestFacts,
};
use opensesame_pki_core::types::KeyAlgorithm;
use sha2::{Digest as _, Sha256};
use time::OffsetDateTime;

/// A public CA certificate captured once from `ca::generate_root`; its key was
/// discarded. Only its subject and public key are read here.
const ISSUER_PEM: &str = "-----BEGIN CERTIFICATE-----
MIIBNTCB6KADAgECAhBEiXRJHlTZsR8lwM4fGcHVMAUGAytlcDAbMRkwFwYDVQQD
DBBPQ1NQIEdvbGRlbiBSb290MB4XDTI2MTEwNzE0MzQxNloXDTM2MTEwNDE0MzQx
NlowGzEZMBcGA1UEAwwQT0NTUCBHb2xkZW4gUm9vdDAqMAUGAytlcAMhAOjHnfIZ
uW9aRRJCnwkw0ykRUPEeg4zJtAvUxwb+tsdyo0IwQDAOBgNVHQ8BAf8EBAMCAYYw
HQYDVR0OBBYEFFEqCsLPJTmUN2FLjoRw0YnQOEgiMA8GA1UdEwEB/wQFMAMBAf8w
BQYDK2VwA0EAK9+EtATOeJBgCxPzsT6koDY+Jcfke2/Maa+Ar13R1mzzJlis5gDF
iHu/cHeViMLbqIAQB4GoL6oAWstiZADxDg==
-----END CERTIFICATE-----
";

const REQUEST_DER: &str = "3051304f304d304b3049300906052b0e03021a05000414111111111111111111111111\
111111111111111104142222222222222222222222222222222222222222\
02100102030405060708090a0b0c0d0e0f10";
const GOOD_SHA256: &str = "ae45352d23f3a3f812deb3f3e6b883a3778d2bf43c5f0001332d0c34049ac962";
const REVOKED_SHA256: &str = "88aeacb6b38509ef708969ad9ee63a7cbde4fa50680c5105051da5e628efef6f";
const UNKNOWN_SHA256: &str = "5f8017a7dad2153be63805a9bdc0e25d6cc76f52c2a82f9c9731a01ad9730867";

fn hex(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

fn facts() -> OcspRequestFacts {
    OcspRequestFacts {
        serial_hex: "0102030405060708090a0b0c0d0e0f10".into(),
        issuer_name_hash: vec![0x11; 20],
        issuer_key_hash: vec![0x22; 20],
        hash_algorithm_oid: "1.3.14.3.2.26".into(),
    }
}

fn at(unix: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(unix).expect("valid timestamp")
}

/// A delegated responder whose key is a fixed Ed25519 seed, wrapped as the
/// RFC 8410 PKCS#8 `OneAsymmetricKey` at run time.
fn responder() -> keys::KeyPair {
    let mut der = vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ];
    der.extend_from_slice(&[7u8; 32]);
    let body = base64::engine::general_purpose::STANDARD.encode(der);
    let label = "PRIVATE KEY";
    let pem = format!("-----BEGIN {label}-----\n{body}\n-----END {label}-----\n");
    keys::from_pkcs8_pem(&pem, KeyAlgorithm::Ed25519).expect("ed25519 key imports")
}

fn response(status: OcspCertStatus) -> Vec<u8> {
    build_ocsp_response(
        ISSUER_PEM,
        &responder(),
        status,
        &facts(),
        at(1_767_225_600),
        at(1_767_830_400),
    )
    .expect("response builds")
}

fn revoked() -> OcspCertStatus {
    OcspCertStatus::Revoked {
        at: at(1_767_139_200),
        reason: 1,
    }
}

#[test]
fn the_request_encoding_is_frozen() {
    let der = build_ocsp_request(&facts()).expect("request builds");
    assert_eq!(hex(&der), REQUEST_DER);
    assert_eq!(parse_ocsp_request(&der).expect("request parses"), facts());
}

#[test]
fn every_response_encoding_is_frozen() {
    for (status, expected) in [
        (OcspCertStatus::Good, GOOD_SHA256),
        (revoked(), REVOKED_SHA256),
        (OcspCertStatus::Unknown, UNKNOWN_SHA256),
    ] {
        let der = response(status);
        assert_eq!(hex(&Sha256::digest(&der)), expected, "{status:?}");
        let parsed = parse_ocsp_response(&der).expect("response parses");
        assert_eq!(parsed.cert_status, status);
        assert_eq!(parsed.serial_hex, facts().serial_hex);
        assert_eq!(parsed.produced_at, at(1_767_225_600));
        assert_eq!(parsed.next_update, Some(at(1_767_830_400)));
    }
}

#[test]
#[ignore = "prints fresh goldens; run by hand only when adding a vector"]
fn print_fresh_goldens() {
    let now = OffsetDateTime::now_utc();
    let root = opensesame_pki_core::ca::generate_root(&opensesame_pki_core::ca::CaParams {
        subject: opensesame_pki_core::types::SubjectDn::common_name("OCSP Golden Root"),
        key_algorithm: KeyAlgorithm::Ed25519,
        not_before: now,
        not_after: now + time::Duration::days(3650),
        path_len: None,
        crl_distribution_points: Vec::new(),
    })
    .expect("root");
    println!("ISSUER_PEM={}", root.certificate_pem.replace('\n', "\\n"));
    println!(
        "REQUEST_DER={}",
        hex(&build_ocsp_request(&facts()).unwrap())
    );
    for status in [OcspCertStatus::Good, revoked(), OcspCertStatus::Unknown] {
        let der = build_ocsp_response(
            &root.certificate_pem,
            &responder(),
            status,
            &facts(),
            at(1_767_225_600),
            at(1_767_830_400),
        )
        .unwrap();
        println!("{status:?}={}", hex(&Sha256::digest(&der)));
    }
}
