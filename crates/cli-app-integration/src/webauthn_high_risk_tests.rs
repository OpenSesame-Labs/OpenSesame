//! Paused approvals cannot inherit a pending request or an approved session.
//! The `lean_*` tests replay `spec/formal/host-cli` vectors against the real
//! verifier and store; run them through `spec/formal/host-cli/verify.sh`.

use base64::Engine as _;
use ecdsa::signature::Signer;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::Generate;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::device_crypto::{approval_challenge_digest_v3, ApprovalChallengeDigestV3};
use crate::pairing::MAX_PIN_PROOF_FAILURES;
use crate::test_support::{ensure_params_full, mint_test_human_proof, test_paired_binding};
use crate::webauthn_assertion::verify_passkey_assertion;
use crate::{ApprovedSession, CliAppIntegrationStore, PendingRequest, WebAuthnCredential};

pub(super) const PAIRED: &str = "http://localhost:5180";
const UNPAIRABLE: &str = "http://example.test:5180";
const FOREIGN: &str = "https://evil.example";
const TERMINAL: &str = "term-a";

#[test]
fn every_verb_is_denied_before_pending_coalescing_or_session_reuse() {
    let mut store = CliAppIntegrationStore::new();
    store.set_now_ms(1_000);
    store
        .approved
        .insert(TERMINAL.into(), session(1_000, 1_000));
    store
        .pending
        .insert("existing".into(), pending_row("reveal", 1_000));
    for verb in [
        "run",
        "pass-reveal",
        "read",
        "reveal",
        "env-resolve",
        "unknown",
    ] {
        for reuse in [false, true] {
            let params = ensure_params_full(TERMINAL, verb, reuse, "00", 42, 7, true);
            assert_eq!(store.ensure(params), ("denied".into(), None));
        }
    }
    assert_eq!(store.list_pending().len(), 1);
    let proof = mint_test_human_proof("existing", TERMINAL, "nonce", "reveal", 42, 7);
    let binding = test_paired_binding();
    let outcome = store.approve("existing", TERMINAL, "nonce", &proof, &binding);
    assert_eq!(outcome.0, "wrongSession");
    assert_eq!(store.list_pending().len(), 1);
}

fn session(approved_at_ms: u64, last_activity_ms: u64) -> ApprovedSession {
    ApprovedSession {
        approved_at_ms,
        last_activity_ms,
    }
}

fn pending_row(verb: &str, created_at_ms: u64) -> PendingRequest {
    PendingRequest {
        request_id: "existing".into(),
        terminal_session_id: TERMINAL.into(),
        verb: verb.into(),
        reference: None,
        created_at_ms,
        respond_nonce: "nonce".into(),
        argv_hash: "00".into(),
        peer_pid: 42,
        peer_start_time: 7,
        approvable: true,
    }
}

/// Lines of one vector family from the Lean-emitted file, without the tag.
pub(super) fn vectors(family: &str) -> Vec<Vec<String>> {
    let path = std::env::var("OPENSESAME_HOST_CLI_VECTORS").expect("run the host-cli verifier");
    let text = std::fs::read_to_string(path).expect("read formal vectors");
    text.lines()
        .map(|line| line.split('\t').map(str::to_owned).collect::<Vec<_>>())
        .filter(|fields| fields[0] == family)
        .map(|fields| fields[1..].to_vec())
        .collect()
}

pub(super) fn bit(value: &str) -> bool {
    match value {
        "0" => false,
        "1" => true,
        _ => panic!("invalid formal bit {value}"),
    }
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub(super) fn auth_data(rp_host: &str, flags: u8, count: u32, long: bool) -> Vec<u8> {
    let mut data = Sha256::digest(rp_host.as_bytes()).to_vec();
    data.push(flags);
    data.extend_from_slice(&count.to_be_bytes());
    data.truncate(if long { 37 } else { 36 });
    data
}

/// An assertion wire; an invalid signature covers different bytes.
pub(super) fn wire(key: &SigningKey, id: &str, auth: &[u8], client: &[u8], valid: bool) -> String {
    let mut signed = auth.to_vec();
    signed.extend_from_slice(&Sha256::digest(client));
    if !valid {
        signed.push(0);
    }
    let signature: p256::ecdsa::Signature = key.sign(&signed);
    json!({
        "credentialIdB64": id,
        "authenticatorDataB64": b64(auth),
        "clientDataJsonB64": b64(client),
        "signatureB64": b64(&signature.to_bytes()),
    })
    .to_string()
}

pub(super) fn get_client_data(origin: &str, challenge: &[u8; 32]) -> Vec<u8> {
    let data = json!({"type":"webauthn.get","challenge":b64(challenge),"origin":origin,"crossOrigin":false});
    data.to_string().into_bytes()
}

fn wa1_client_data(f: &[String], paired: &str, challenge: &[u8; 32]) -> Vec<u8> {
    let mut data = Map::new();
    let ty = if f[1] == "ClientType.get" {
        "webauthn.get"
    } else {
        "webauthn.create"
    };
    data.insert("type".into(), json!(ty));
    data.insert("challenge".into(), json!(b64(challenge)));
    let origin = if bit(&f[2]) { paired } else { FOREIGN };
    data.insert("origin".into(), json!(origin));
    match f[3].as_str() {
        "Cross.absent" => None,
        "Cross.no" => data.insert("crossOrigin".into(), json!(false)),
        "Cross.yes" => data.insert("crossOrigin".into(), json!(true)),
        other => panic!("invalid cross-origin facet {other}"),
    };
    match f[4].as_str() {
        "Top.absent" => None,
        "Top.same" => data.insert("topOrigin".into(), json!(paired)),
        "Top.other" => data.insert("topOrigin".into(), json!(FOREIGN)),
        other => panic!("invalid top-origin facet {other}"),
    };
    Value::Object(data).to_string().into_bytes()
}

fn wa1_case(key: &SigningKey, spki: &str, f: &[String]) -> (String, [u8; 32], WebAuthnCredential) {
    let expected = [7u8; 32];
    let paired = if bit(&f[6]) { PAIRED } else { UNPAIRABLE };
    let challenge = if bit(&f[5]) { expected } else { [8u8; 32] };
    let client = wa1_client_data(f, paired, &challenge);
    let host = url::Url::parse(paired)
        .unwrap()
        .host_str()
        .unwrap()
        .to_owned();
    let rp_host = if bit(&f[7]) {
        host.as_str()
    } else {
        "evil.example"
    };
    let flags = u8::from(bit(&f[8])) | (u8::from(bit(&f[9])) << 2);
    let auth = auth_data(rp_host, flags, f[11].parse().unwrap(), bit(&f[10]));
    let id = if bit(&f[0]) { "cred-a" } else { "cred-b" };
    let stored = WebAuthnCredential {
        credential_id_b64: "cred-a".into(),
        public_key_spki_b64: spki.into(),
        sign_count: f[13].parse().unwrap(),
        origin: paired.into(),
    };
    (wire(key, id, &auth, &client, bit(&f[12])), expected, stored)
}

#[test]
#[ignore = "requires Lean vectors; run spec/formal/host-cli/verify.sh"]
fn lean_assertion_vectors_match_verify_passkey_assertion() {
    let key = SigningKey::generate();
    let spki = crate::device_crypto::verifying_key_spki_b64(key.verifying_key());
    let cases = vectors("wa1");
    for f in &cases {
        let (proof, challenge, stored) = wa1_case(&key, &spki, f);
        let actual = verify_passkey_assertion(&proof, &challenge, &stored);
        let actual = actual.map_or_else(|| "-".to_owned(), |count| count.to_string());
        assert_eq!(actual, f[14], "decision mismatch for wa1 {}", f.join(" "));
    }
    assert_eq!(cases.len(), 1224, "incomplete wa1 vectors");
}

fn wa3_store(f: &[String], now: u64) -> CliAppIntegrationStore {
    let policy = crate::policy::policy();
    let idle = policy.idle_timeout_seconds * 1000;
    let hard = policy.hard_limit_seconds * 1000;
    let ttl = policy.request_timeout_seconds * 1000;
    let mut store = CliAppIntegrationStore::new();
    store.set_now_ms(now);
    let approved = match f[1].as_str() {
        "Session.none" => None,
        "Session.fresh" => Some(session(now, now)),
        "Session.idle" => Some(session(now - idle - 1, now - idle - 1)),
        "Session.hard" => Some(session(now - hard - 1, now)),
        other => panic!("invalid session facet {other}"),
    };
    if let Some(approved) = approved {
        store.approved.insert(TERMINAL.into(), approved);
    }
    let created = match f[2].as_str() {
        "Pending.none" => None,
        "Pending.live" => Some(now),
        "Pending.stale" => Some(now - ttl - 1),
        other => panic!("invalid pending facet {other}"),
    };
    if let Some(created) = created {
        store
            .pending
            .insert("existing".into(), pending_row("read", created));
    }
    if bit(&f[3]) {
        store.denied.insert(TERMINAL.into());
    }
    store
}

fn approved_facts(store: &CliAppIntegrationStore) -> Option<(u64, u64)> {
    store
        .approved
        .get(TERMINAL)
        .map(|s| (s.approved_at_ms, s.last_activity_ms))
}

#[test]
#[ignore = "requires Lean vectors; run spec/formal/host-cli/verify.sh"]
fn lean_ensure_vectors_match_the_session_store() {
    let now = 100_000_000;
    let cases = vectors("wa3e");
    for f in &cases {
        let mut store = wa3_store(f, now);
        let (approved, denied) = (approved_facts(&store), store.denied.clone());
        let params = ensure_params_full(TERMINAL, &f[0], bit(&f[4]), "00", 42, 7, bit(&f[5]));
        let outcome = match store.ensure(params) {
            (state, None) if state == "denied" => "Ensure.denied".to_owned(),
            (state, id) => format!("{state}:{id:?}"),
        };
        let pending = if store.pending.contains_key("existing") {
            "Pending.live"
        } else {
            "Pending.none"
        };
        let unchanged = approved_facts(&store) == approved && store.denied == denied;
        let fresh = store.next_request == 0 && store.pending.len() <= 1;
        let actual = format!("{outcome}\t{pending}\t{unchanged}\t{fresh}");
        let expected = format!("{}\t{}\ttrue\ttrue", f[6], f[7]);
        assert_eq!(
            actual,
            expected,
            "decision mismatch for wa3e {}",
            f.join(" ")
        );
    }
    assert_eq!(cases.len(), 768, "incomplete wa3e vectors");
}

fn labeled(proof: &str, label: &str) -> String {
    let tail = proof
        .strip_prefix("oschip3:passkey:")
        .expect("passkey proof");
    match label {
        "Label.passkey" => proof.to_owned(),
        "Label.software" => format!("oschip3:software-passkey:{tail}"),
        "Label.pin" => format!("oschip3:pin:{tail}"),
        "Label.v2passkey" => format!("oschip2:passkey:{tail}"),
        "Label.v1pin" => format!("oschip1:pin:{tail}"),
        "Label.bare" => tail.to_owned(),
        other => panic!("invalid proof label {other}"),
    }
}

/// The proof's signed bytes must verify on their own when `valid`, so a
/// refusal is the approval pause and not a broken fixture.
fn wa3_proof(verb: &str, valid: bool) -> String {
    let request = if valid { "existing" } else { "other" };
    let proof = mint_test_human_proof(request, TERMINAL, "nonce", verb, 42, 7);
    let challenge = approval_challenge_digest_v3(&ApprovalChallengeDigestV3 {
        daemon_id: &crate::daemon_integration_id(),
        request_id: "existing",
        terminal_session_id: TERMINAL,
        respond_nonce: "nonce",
        verb,
        argv_hash: "00",
        peer_pid: 42,
        peer_start_time: 7,
    });
    let tail = proof.strip_prefix("oschip3:passkey:").unwrap();
    let credential = test_paired_binding().webauthn.unwrap();
    let verifies = verify_passkey_assertion(tail, &challenge, &credential).is_some();
    assert_eq!(verifies, valid, "fixture proof validity for {verb}");
    proof
}

fn wa3_context(verb: &str) -> crate::human_proof::HumanProofContext {
    crate::human_proof::HumanProofContext {
        daemon_id: crate::daemon_integration_id(),
        request_id: "existing".into(),
        terminal_session_id: TERMINAL.into(),
        respond_nonce: "nonce".into(),
        verb: verb.into(),
        argv_hash: "00".into(),
        peer_pid: 42,
        peer_start_time: 7,
    }
}

#[test]
#[ignore = "requires Lean vectors; run spec/formal/host-cli/verify.sh"]
fn lean_human_proof_vectors_match_verification_and_approval() {
    let cases = vectors("wa3p");
    for f in &cases {
        let proof = labeled(&wa3_proof(&f[0], bit(&f[2])), &f[1]);
        let mut binding = test_paired_binding();
        if bit(&f[3]) {
            binding.pin_proof_failures = MAX_PIN_PROOF_FAILURES;
        }
        let verified =
            crate::human_proof::human_proof_verify(&proof, &binding, &wa3_context(&f[0]))
                .map_or_else(|| "-".to_owned(), |o| o.into_sign_count().to_string());
        let mut store = CliAppIntegrationStore::new();
        store
            .pending
            .insert("existing".into(), pending_row(&f[0], 0));
        let unlocked = test_paired_binding();
        let (state, _) = store.approve("existing", TERMINAL, "nonce", &proof, &unlocked);
        let approved =
            state == "approved" || !store.approved.is_empty() || store.pending.is_empty();
        let actual = format!("{verified}\t{}", u8::from(approved));
        let expected = format!("{}\t{}", f[4], f[5]);
        assert_eq!(
            actual,
            expected,
            "decision mismatch for wa3p {}",
            f.join(" ")
        );
    }
    assert_eq!(cases.len(), 192, "incomplete wa3p vectors");
}
