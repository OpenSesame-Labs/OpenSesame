//! Human proof tokens minted in Pages after PIN or passkey unlock (`oschip3:`).

use crate::device_crypto::{approval_challenge_digest_v3, ApprovalChallengeDigestV3};
use crate::pairing::PairedBinding;
use crate::webauthn_assertion::verify_passkey_assertion;
#[cfg(any(test, feature = "test-seams"))]
use p256::elliptic_curve::Generate;

const PROOF_PREFIX: &str = "oschip3:";

fn approval_challenge_input(ctx: &HumanProofContext) -> ApprovalChallengeDigestV3<'_> {
    ApprovalChallengeDigestV3 {
        daemon_id: &ctx.daemon_id,
        request_id: &ctx.request_id,
        terminal_session_id: &ctx.terminal_session_id,
        respond_nonce: &ctx.respond_nonce,
        verb: &ctx.verb,
        argv_hash: &ctx.argv_hash,
        peer_pid: ctx.peer_pid,
        peer_start_time: ctx.peer_start_time,
    }
}

#[derive(Clone)]
pub struct HumanProofContext {
    pub daemon_id: String,
    pub request_id: String,
    pub terminal_session_id: String,
    pub respond_nonce: String,
    pub verb: String,
    pub argv_hash: String,
    pub peer_pid: u32,
    pub peer_start_time: u64,
}

/// Verified passkey assertion and its sign count, which can remain zero.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HumanProofOutcome {
    Passkey(u32),
}

impl HumanProofOutcome {
    #[must_use]
    pub(crate) fn into_sign_count(self) -> u32 {
        match self {
            Self::Passkey(count) => count,
        }
    }
}

pub(crate) fn human_proof_verify(
    proof: &str,
    binding: &PairedBinding,
    ctx: &HumanProofContext,
) -> Option<HumanProofOutcome> {
    if crate::is_approval_blocked(&ctx.verb)
        || binding.pin_proof_failures >= crate::pairing::MAX_PIN_PROOF_FAILURES
    {
        return None;
    }
    let t = proof.trim();
    if t.starts_with("oschip1:") || t.starts_with("oschip2:") {
        return None;
    }
    let rest = t.strip_prefix(PROOF_PREFIX)?;
    let challenge = approval_challenge_digest_v3(&approval_challenge_input(ctx));
    if let Some((kind, tail)) = rest.split_once(':') {
        if kind == "pin" {
            // Pairing device keys are client-chosen; PIN proofs must not verify
            // against them (main #1366). Passkey proofs carry approval.
            return None;
        }
        if kind == "software-passkey" || kind == "passkey" {
            let webauthn = binding.webauthn.as_ref()?;
            return verify_passkey_assertion(tail, &challenge, webauthn)
                .map(HumanProofOutcome::Passkey);
        }
    }
    None
}

/// Mint a PIN proof for integration tests (device signing key required).
#[cfg(any(test, feature = "test-seams"))]
#[must_use]
pub fn mint_pin_human_proof(
    signing_key: &p256::ecdsa::SigningKey,
    ctx: &HumanProofContext,
) -> String {
    use base64::Engine as _;
    use ecdsa::signature::Signer;
    let challenge = approval_challenge_digest_v3(&approval_challenge_input(ctx));
    let sig: p256::ecdsa::Signature = signing_key.sign(&challenge);
    let sig_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes());
    format!("{PROOF_PREFIX}pin:{sig_b64}")
}

#[cfg(any(test, feature = "test-seams"))]
#[must_use]
pub fn mint_test_signing_key() -> p256::ecdsa::SigningKey {
    p256::ecdsa::SigningKey::generate()
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::SigningKey;

    fn ctx() -> HumanProofContext {
        HumanProofContext {
            daemon_id: "daemon-test".into(),
            request_id: "clr_1".into(),
            terminal_session_id: "term-a".into(),
            respond_nonce: "nonce".into(),
            verb: "reveal".into(),
            argv_hash: "00".into(),
            peer_pid: 42,
            peer_start_time: 1,
        }
    }

    #[test]
    fn rejects_legacy_oschip1_and_oschip2_proofs() {
        let binding = PairedBinding {
            device_public_key_spki_b64: String::new(),
            webauthn: None,
            pin_proof_failures: 0,
        };
        let c = ctx();
        assert!(human_proof_verify(
            "oschip1:pin:0000000000000000000000000000000000000000000000000000000000000000",
            &binding,
            &c,
        )
        .is_none());
        assert!(human_proof_verify(
            "oschip2:pin:0000000000000000000000000000000000000000000000000000000000000000",
            &binding,
            &c,
        )
        .is_none());
    }

    #[test]
    fn pin_proof_rejected_even_with_paired_device_key() {
        let signing_key = SigningKey::generate();
        let spki = crate::device_crypto::verifying_key_spki_b64(signing_key.verifying_key());
        let c = ctx();
        let proof = mint_pin_human_proof(&signing_key, &c);
        let binding = PairedBinding {
            device_public_key_spki_b64: spki,
            webauthn: None,
            pin_proof_failures: 0,
        };
        // PIN proofs never verify against the client-chosen pairing device
        // key, even when the signature matches it (main #1366).
        assert!(human_proof_verify(&proof, &binding, &c).is_none());
        let mut wrong = c.clone();
        wrong.request_id = "clr_2".into();
        assert!(human_proof_verify(&proof, &binding, &wrong).is_none());
    }

    #[test]
    fn ark_only_pin_rejected_when_passkey_registered() {
        let signing_key = SigningKey::generate();
        let spki = crate::device_crypto::verifying_key_spki_b64(signing_key.verifying_key());
        let c = ctx();
        let proof = mint_pin_human_proof(&signing_key, &c);
        let binding = PairedBinding {
            device_public_key_spki_b64: spki.clone(),
            webauthn: Some(crate::pairing::WebAuthnCredential {
                credential_id_b64: "cred".into(),
                public_key_spki_b64: spki,
                sign_count: 0,
                origin: "http://localhost:5180".into(),
            }),
            pin_proof_failures: 0,
        };
        assert!(human_proof_verify(&proof, &binding, &c).is_none());
    }

    #[test]
    fn all_verbs_are_refused_for_both_passkey_labels() {
        use crate::test_support::{mint_test_human_proof, test_paired_binding};

        let binding = test_paired_binding();
        for verb in [
            "run",
            "pass-reveal",
            "read",
            "reveal",
            "env-resolve",
            "unknown",
        ] {
            let mut c = ctx();
            c.daemon_id = crate::daemon_integration_id();
            c.verb = verb.to_string();
            let proof = mint_test_human_proof(
                &c.request_id,
                &c.terminal_session_id,
                &c.respond_nonce,
                verb,
                c.peer_pid,
                c.peer_start_time,
            );
            let software = proof.replacen("oschip3:passkey:", "oschip3:software-passkey:", 1);
            let challenge = approval_challenge_digest_v3(&approval_challenge_input(&c));
            let tail = proof.strip_prefix("oschip3:passkey:").unwrap();
            assert!(
                verify_passkey_assertion(tail, &challenge, binding.webauthn.as_ref().unwrap())
                    .is_some()
            );
            assert!(human_proof_verify(&proof, &binding, &c).is_none());
            assert!(human_proof_verify(&software, &binding, &c).is_none());
        }
    }

    #[test]
    fn persona_forged_passkey_bytes_are_rejected_without_webauthn_cred() {
        let signing_key = SigningKey::generate();
        let spki = crate::device_crypto::verifying_key_spki_b64(signing_key.verifying_key());
        let binding = PairedBinding {
            device_public_key_spki_b64: spki.clone(),
            webauthn: Some(crate::pairing::WebAuthnCredential {
                credential_id_b64: "cred".into(),
                public_key_spki_b64: spki,
                sign_count: 0,
                origin: "http://localhost:5180".into(),
            }),
            pin_proof_failures: 0,
        };
        let attack = format!(
            "{PROOF_PREFIX}passkey:{}",
            serde_json::json!({
                "credentialIdB64": "cred",
                "authenticatorDataB64": "AA",
                "clientDataJsonB64": "AA",
                "signatureB64": "AA",
            })
        );
        assert!(human_proof_verify(&attack, &binding, &ctx()).is_none());
    }

    #[test]
    fn counterless_passkey_is_accepted_and_a_replay_is_not() {
        use crate::daemon_integration_id;
        use crate::test_support::{mint_test_passkey_human_proof, test_paired_binding};

        let ctx = HumanProofContext {
            daemon_id: daemon_integration_id(),
            request_id: "clr_1".into(),
            terminal_session_id: "term-a".into(),
            respond_nonce: "nonce".into(),
            verb: "read".into(),
            argv_hash: "00".into(),
            peer_pid: 0,
            peer_start_time: 0,
        };
        let mut binding = test_paired_binding();
        let challenge = approval_challenge_digest_v3(&approval_challenge_input(&ctx));
        let verify = |proof: &str, binding: &PairedBinding| {
            verify_passkey_assertion(
                proof.strip_prefix("oschip3:passkey:").unwrap(),
                &challenge,
                binding.webauthn.as_ref().unwrap(),
            )
        };
        let zero = mint_test_passkey_human_proof("clr_1", "term-a", "nonce", "read", 0);
        assert_eq!(verify(&zero, &binding), Some(0));
        binding.webauthn.as_mut().expect("cred").sign_count = 1;
        assert!(verify(&zero, &binding).is_none());
        let replay = mint_test_passkey_human_proof("clr_1", "term-a", "nonce", "read", 1);
        assert!(verify(&replay, &binding).is_none());
        let next = mint_test_passkey_human_proof("clr_1", "term-a", "nonce", "read", 2);
        assert_eq!(verify(&next, &binding), Some(2));
    }
}
