//! A pairing cannot replace its credential or roll its counter back.

use base64::Engine as _;
use ecdsa::signature::Signer;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::Generate;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::device_crypto::{verifying_key_spki_b64, webauthn_register_challenge_digest};
use crate::test_support::{
    mint_register_passkey_proof, pair_browser_without_webauthn_for_tests,
    test_approval_public_key_spki_b64, TEST_VAULT_SESSION_ROOT_DIGEST,
};
use crate::webauthn_assertion::verify_passkey_assertion;
use crate::{CliAppIntegrationPairings, PairingError, WebAuthnCredential, WebAuthnRegistration};

const ORIGIN: &str = "http://localhost:5180";
const CREDENTIAL: &str = "test-cli-app-cred";
const PREFIX: &str = "oschip2:passkey:";

fn registration(token: &str, count: u32) -> WebAuthnRegistration {
    WebAuthnRegistration {
        vault_session_root_digest: TEST_VAULT_SESSION_ROOT_DIGEST.into(),
        human_proof_passkey: mint_register_passkey_proof(token, ORIGIN, count),
        credential_id_b64: CREDENTIAL.into(),
        public_key_spki_b64: test_approval_public_key_spki_b64().into(),
        sign_count: 99,
    }
}

fn credential(pairings: &CliAppIntegrationPairings, token: &str) -> WebAuthnCredential {
    pairings
        .binding_for(token, ORIGIN)
        .unwrap()
        .webauthn
        .unwrap()
}

#[test]
fn same_credential_retries_do_not_lower_the_verified_counter() {
    let mut pairings = CliAppIntegrationPairings::default();
    let token = pair_browser_without_webauthn_for_tests(&mut pairings, ORIGIN, 4_000);
    let first = registration(&token, 0);
    pairings.register_webauthn(&token, ORIGIN, &first).unwrap();
    assert_eq!(credential(&pairings, &token).sign_count, 0);
    assert!(pairings.advance_webauthn_sign_count(&token, ORIGIN, 0));
    assert!(pairings.advance_webauthn_sign_count(&token, ORIGIN, 2));

    pairings.register_webauthn(&token, ORIGIN, &first).unwrap();
    assert_eq!(credential(&pairings, &token).sign_count, 2);
    assert!(!pairings.advance_webauthn_sign_count(&token, ORIGIN, 0));
    assert!(!pairings.advance_webauthn_sign_count(&token, ORIGIN, 2));

    let newer = registration(&token, 3);
    pairings.register_webauthn(&token, ORIGIN, &newer).unwrap();
    assert_eq!(credential(&pairings, &token).sign_count, 3);

    let mut invalid = registration(&token, 4);
    invalid.human_proof_passkey = format!("{PREFIX}{{}}");
    assert!(matches!(
        pairings.register_webauthn(&token, ORIGIN, &invalid),
        Err(PairingError::InvalidProof)
    ));
    assert_eq!(credential(&pairings, &token).sign_count, 3);
}

fn signed_replacement(token: &str, change_id: bool) -> WebAuthnRegistration {
    let mut replacement = registration(token, 1);
    let tail = replacement
        .human_proof_passkey
        .strip_prefix(PREFIX)
        .unwrap();
    let mut wire: serde_json::Value = serde_json::from_str(tail).unwrap();
    if change_id {
        replacement.credential_id_b64 = "other-credential".into();
        wire["credentialIdB64"] = json!(replacement.credential_id_b64);
    } else {
        let key = SigningKey::generate();
        replacement.public_key_spki_b64 = verifying_key_spki_b64(key.verifying_key());
        let decode = |field: &str| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(wire[field].as_str().unwrap())
                .unwrap()
        };
        let mut signed = decode("authenticatorDataB64");
        signed.extend_from_slice(&Sha256::digest(decode("clientDataJsonB64")));
        let signature: p256::ecdsa::Signature = key.sign(&signed);
        wire["signatureB64"] =
            json!(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes()));
    }
    replacement.human_proof_passkey = format!("{PREFIX}{wire}");
    replacement
}

#[test]
fn valid_proof_cannot_replace_the_registered_key_or_credential_id() {
    let mut pairings = CliAppIntegrationPairings::default();
    let token = pair_browser_without_webauthn_for_tests(&mut pairings, ORIGIN, 4_000);
    let initial = registration(&token, 1);
    pairings
        .register_webauthn(&token, ORIGIN, &initial)
        .unwrap();
    assert!(pairings.advance_webauthn_sign_count(&token, ORIGIN, 5));

    for change_id in [false, true] {
        let replacement = signed_replacement(&token, change_id);
        let candidate = WebAuthnCredential {
            credential_id_b64: replacement.credential_id_b64.clone(),
            public_key_spki_b64: replacement.public_key_spki_b64.clone(),
            sign_count: 0,
            origin: ORIGIN.into(),
        };
        let challenge =
            webauthn_register_challenge_digest(&token, ORIGIN, TEST_VAULT_SESSION_ROOT_DIGEST);
        assert_eq!(
            verify_passkey_assertion(
                replacement
                    .human_proof_passkey
                    .strip_prefix(PREFIX)
                    .unwrap(),
                &challenge,
                &candidate,
            ),
            Some(1)
        );
        assert!(matches!(
            pairings.register_webauthn(&token, ORIGIN, &replacement),
            Err(PairingError::InvalidProof)
        ));
        let current = credential(&pairings, &token);
        assert_eq!(current.credential_id_b64, initial.credential_id_b64);
        assert_eq!(current.public_key_spki_b64, initial.public_key_spki_b64);
        assert_eq!(current.sign_count, 5);
    }

    let fresh = pair_browser_without_webauthn_for_tests(&mut pairings, ORIGIN, 4_001);
    let replacement = signed_replacement(&fresh, false);
    pairings
        .register_webauthn(&fresh, ORIGIN, &replacement)
        .unwrap();
    assert_eq!(
        credential(&pairings, &fresh).public_key_spki_b64,
        replacement.public_key_spki_b64
    );
}
