//! Signed assertions exercise origin, RP and user-presence boundaries.

use super::*;
use ecdsa::signature::Signer;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::pkcs8::EncodePublicKey;
use p256::elliptic_curve::Generate;
use p256::PublicKey;
use serde_json::json;

const ORIGIN: &str = "https://pages.example.test:8443";
const RP_ID: &str = "pages.example.test";
const CHALLENGE: [u8; 32] = [0x42; 32];

struct Case<'a> {
    origin: Option<&'a str>,
    rp_id: &'a str,
    flags: u8,
    cross_origin: Option<bool>,
    top_origin: Option<&'a str>,
    count: u32,
}

fn fixture(origin: &str) -> (SigningKey, WebAuthnCredential) {
    let key = SigningKey::generate();
    let public = PublicKey::from(key.verifying_key());
    let spki = public.to_public_key_der().unwrap();
    let credential = WebAuthnCredential {
        credential_id_b64: "test-credential".into(),
        public_key_spki_b64: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(spki.as_ref()),
        sign_count: 0,
        origin: origin.into(),
    };
    (key, credential)
}

fn signed_wire(key: &SigningKey, challenge: &[u8; 32], case: &Case<'_>) -> String {
    let mut client = json!({
        "type": "webauthn.get",
        "challenge": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(challenge),
    });
    if let Some(origin) = case.origin {
        client["origin"] = json!(origin);
    }
    if let Some(cross) = case.cross_origin {
        client["crossOrigin"] = json!(cross);
    }
    if let Some(top) = case.top_origin {
        client["topOrigin"] = json!(top);
    }
    let client = serde_json::to_vec(&client).unwrap();
    let mut auth_data = vec![0u8; 37];
    auth_data[..32].copy_from_slice(&Sha256::digest(case.rp_id.as_bytes()));
    auth_data[32] = case.flags;
    auth_data[33..37].copy_from_slice(&case.count.to_be_bytes());
    let mut signed = auth_data.clone();
    signed.extend_from_slice(&Sha256::digest(&client));
    let signature: p256::ecdsa::Signature = key.sign(&signed);
    json!({
        "credentialIdB64": "test-credential",
        "authenticatorDataB64": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(auth_data),
        "clientDataJsonB64": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(client),
        "signatureB64": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes()),
    }).to_string()
}

fn good<'a>() -> Case<'a> {
    Case {
        origin: Some(ORIGIN),
        rp_id: RP_ID,
        flags: 0x05,
        cross_origin: Some(false),
        top_origin: None,
        count: 1,
    }
}

#[test]
fn signed_matching_origin_and_rp_are_accepted() {
    let (key, stored) = fixture(ORIGIN);
    assert_eq!(
        verify_passkey_assertion(&signed_wire(&key, &CHALLENGE, &good()), &CHALLENGE, &stored),
        Some(1)
    );
    let mut no_cross_origin_field = good();
    no_cross_origin_field.cross_origin = None;
    assert_eq!(
        verify_passkey_assertion(
            &signed_wire(&key, &CHALLENGE, &no_cross_origin_field),
            &CHALLENGE,
            &stored
        ),
        Some(1)
    );
    let (local_key, local) = fixture("http://localhost:5180");
    let mut local_case = good();
    local_case.origin = Some("http://localhost:5180");
    local_case.rp_id = "localhost";
    assert_eq!(
        verify_passkey_assertion(
            &signed_wire(&local_key, &CHALLENGE, &local_case),
            &CHALLENGE,
            &local
        ),
        Some(1)
    );
}

#[test]
fn signed_wrong_origins_or_cross_origin_are_refused() {
    let (key, stored) = fixture(ORIGIN);
    let cases = [
        Case {
            origin: None,
            ..good()
        },
        Case {
            origin: Some("https://other.example.test:8443"),
            ..good()
        },
        Case {
            origin: Some("https://pages.example.test"),
            ..good()
        },
        Case {
            cross_origin: Some(true),
            ..good()
        },
        Case {
            top_origin: Some("https://other.example.test"),
            ..good()
        },
    ];
    for case in cases {
        assert_eq!(
            verify_passkey_assertion(&signed_wire(&key, &CHALLENGE, &case), &CHALLENGE, &stored),
            None
        );
    }
}

#[test]
fn signed_wrong_rp_and_missing_presence_or_verification_are_refused() {
    let (key, stored) = fixture(ORIGIN);
    for case in [
        Case {
            rp_id: "example.test",
            ..good()
        },
        Case {
            rp_id: "pages.example.test:8443",
            ..good()
        },
        Case { flags: 0, ..good() },
        Case {
            flags: 0x01,
            ..good()
        },
        Case {
            flags: 0x04,
            ..good()
        },
    ] {
        assert_eq!(
            verify_passkey_assertion(&signed_wire(&key, &CHALLENGE, &case), &CHALLENGE, &stored),
            None
        );
    }
}

#[test]
fn malformed_stored_origin_or_stale_counter_fails_closed() {
    let (key, mut stored) = fixture(ORIGIN);
    let wire = signed_wire(&key, &CHALLENGE, &good());
    stored.sign_count = 1;
    assert_eq!(verify_passkey_assertion(&wire, &CHALLENGE, &stored), None);
    stored.sign_count = 0;
    for invalid in [
        "",
        "null",
        "http://example.test",
        "https://pages.example.test:8443/",
        "https://user@pages.example.test:8443",
    ] {
        stored.origin = invalid.into();
        assert_eq!(verify_passkey_assertion(&wire, &CHALLENGE, &stored), None);
    }
}

#[test]
fn registration_checks_origin_of_the_signed_assertion() {
    use crate::device_crypto::webauthn_register_challenge_digest;
    use crate::test_support::{
        pair_browser_without_webauthn_for_tests, TEST_VAULT_SESSION_ROOT_DIGEST,
    };
    use crate::{CliAppIntegrationPairings, PairingError, WebAuthnRegistration};

    let mut pairings = CliAppIntegrationPairings::default();
    let token = pair_browser_without_webauthn_for_tests(&mut pairings, ORIGIN, 1_000);
    let (key, candidate) = fixture(ORIGIN);
    let challenge =
        webauthn_register_challenge_digest(&token, ORIGIN, TEST_VAULT_SESSION_ROOT_DIGEST);
    let registration = |case: &Case<'_>| WebAuthnRegistration {
        vault_session_root_digest: TEST_VAULT_SESSION_ROOT_DIGEST.into(),
        human_proof_passkey: format!("oschip2:passkey:{}", signed_wire(&key, &challenge, case)),
        credential_id_b64: candidate.credential_id_b64.clone(),
        public_key_spki_b64: candidate.public_key_spki_b64.clone(),
        sign_count: 1,
    };
    for wrong in [
        Case {
            origin: None,
            ..good()
        },
        Case {
            origin: Some("https://other.example.test"),
            ..good()
        },
        Case {
            cross_origin: Some(true),
            ..good()
        },
        Case {
            rp_id: "example.test",
            ..good()
        },
        Case {
            flags: 0x01,
            ..good()
        },
        Case {
            flags: 0x04,
            ..good()
        },
    ] {
        assert!(matches!(
            pairings.register_webauthn(&token, ORIGIN, &registration(&wrong)),
            Err(PairingError::InvalidProof)
        ));
        assert!(pairings
            .binding_for(&token, ORIGIN)
            .unwrap()
            .webauthn
            .is_none());
    }
    assert!(pairings
        .register_webauthn(&token, ORIGIN, &registration(&good()))
        .is_ok());
    let binding = pairings.binding_for(&token, ORIGIN).unwrap();
    assert_eq!(binding.webauthn.unwrap().origin, ORIGIN);
}

#[test]
fn approval_checks_origin_of_the_signed_assertion() {
    use crate::device_crypto::{approval_challenge_digest_v3, ApprovalChallengeDigestV3};
    use crate::human_proof::{human_proof_verify, HumanProofContext};
    use crate::PairedBinding;

    let (key, credential) = fixture(ORIGIN);
    let binding = PairedBinding {
        device_public_key_spki_b64: String::new(),
        webauthn: Some(credential),
        pin_proof_failures: 0,
    };
    let context = HumanProofContext {
        daemon_id: "daemon".into(),
        request_id: "request".into(),
        terminal_session_id: "terminal".into(),
        respond_nonce: "nonce".into(),
        verb: "read".into(),
        argv_hash: "hash".into(),
        peer_pid: 7,
        peer_start_time: 8,
    };
    let challenge = approval_challenge_digest_v3(&ApprovalChallengeDigestV3 {
        daemon_id: &context.daemon_id,
        request_id: &context.request_id,
        terminal_session_id: &context.terminal_session_id,
        respond_nonce: &context.respond_nonce,
        verb: &context.verb,
        argv_hash: &context.argv_hash,
        peer_pid: context.peer_pid,
        peer_start_time: context.peer_start_time,
    });
    let proof =
        |case: &Case<'_>| format!("oschip3:passkey:{}", signed_wire(&key, &challenge, case));
    for wrong in [
        Case {
            origin: None,
            ..good()
        },
        Case {
            origin: Some("https://other.example.test"),
            ..good()
        },
        Case {
            cross_origin: Some(true),
            ..good()
        },
        Case {
            rp_id: "example.test",
            ..good()
        },
        Case {
            flags: 0x01,
            ..good()
        },
        Case {
            flags: 0x04,
            ..good()
        },
    ] {
        let value = proof(&wrong);
        let tail = value.strip_prefix("oschip3:passkey:").unwrap();
        assert!(
            verify_passkey_assertion(tail, &challenge, binding.webauthn.as_ref().unwrap())
                .is_none()
        );
        assert!(human_proof_verify(&value, &binding, &context).is_none());
    }
    let value = proof(&good());
    let tail = value.strip_prefix("oschip3:passkey:").unwrap();
    assert!(
        verify_passkey_assertion(tail, &challenge, binding.webauthn.as_ref().unwrap()).is_some()
    );
    assert!(human_proof_verify(&value, &binding, &context).is_none());
}
