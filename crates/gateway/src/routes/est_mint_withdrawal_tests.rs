//! A source withdrawn between admission and issuance must not mint.
//!
//! `enroll` authenticates, then awaits the policy and the issuer before it
//! signs. A source whose trust is withdrawn in that window — or evidence that
//! lapses while the database is awaited — must be refused at the mint
//! boundary, not issued a certificate. These tests suspend the request at the
//! mint seam, withdraw the generation, and demand a refusal; the companion
//! control proves the same fixture mints when nothing is withdrawn.
use std::net::SocketAddr;
use std::time::Duration as StdDuration;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use opensesame_connection_broker::crypto::seal_scoped;
use opensesame_domain::transport::{TransportError, TransportPolicy};
use opensesame_pki_core::ca::{self, CaParams};
use opensesame_pki_core::csr;
use opensesame_pki_core::keys;
use opensesame_pki_core::types::{KeyAlgorithm, SubjectDn};
use opensesame_storage::{
    seal_scopes, SealedCertificateMaterial, StoredCaSigningConfig, StoredCertificateAuthority,
    StoredCertificatePolicy, StoredCertificateProfile, StoredEstConfig,
};
use opensesame_transport_security::{
    GenerationCandidate, ListenerProvenance, TransportGenerations,
};
use serde_json::json;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

use super::{basic, router, sealed_state};
use crate::app_state::{test_env, AppState};
use crate::transport::test_support;

fn install_transport(state: &mut AppState) {
    let generation = GenerationCandidate::default()
        .into_generation(1, opensesame_time::Utc::now())
        .expect("generation");
    state.transport = Some(test_support::runtime_serving(
        TransportGenerations::new(generation),
        test_support::set(vec![]),
        test_support::mtls_config(),
    ));
}

/// A policy, a real issuing root, a CA-backed profile, and a sealed
/// passphrase: everything a successful `simpleenroll` needs.
async fn seed_issuing_profile(state: &AppState, passphrase: &str) -> String {
    let organization = state.connection_organization.to_string();
    let now = opensesame_time::Utc::now().to_rfc3339();
    let policy_id = "policy-est-mint".to_owned();
    state
        .db
        .insert_certificate_policy(&StoredCertificatePolicy {
            id: policy_id.clone(),
            organization_id: organization.clone(),
            name: "est mint".into(),
            description: None,
            preset: "tls_client".into(),
            max_validity_seconds: None,
            rules_json: "{}".into(),
            version: 1,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .await
        .expect("policy");
    let generated = ca::generate_root(&CaParams {
        subject: SubjectDn::common_name("EST Mint Root"),
        key_algorithm: KeyAlgorithm::EcdsaP256,
        not_before: OffsetDateTime::now_utc() - Duration::minutes(1),
        not_after: OffsetDateTime::now_utc() + Duration::days(365),
        path_len: None,
        crl_distribution_points: Vec::new(),
    })
    .expect("root ca");
    let authority_id = "certificate-authority:est-mint".to_owned();
    let sealing = super::super::sealing_key(state).expect("sealing key");
    let pem = generated.key.private_key_pkcs8_pem();
    let blob = seal_scoped(
        &sealing,
        "certificate_authority",
        &authority_id,
        &organization,
        pem.as_bytes(),
    )
    .expect("seal ca key");
    state
        .db
        .insert_certificate_authority(&StoredCertificateAuthority {
            id: authority_id.clone(),
            organization_id: organization.clone(),
            issuer_kind: "opensesame_private_ca".into(),
            issuer_connection_id: None,
            display_name: "EST Mint Root".into(),
            public_metadata_json: json!({"certificate": generated.certificate_pem}).to_string(),
            sealed_material: SealedCertificateMaterial {
                key_id: "opensesame-connection-key:v1".into(),
                ciphertext: blob.ciphertext,
                nonce: blob.nonce,
                aad_digest: blob.aad_digest,
            },
            is_default: false,
            status: "active".into(),
            version: 1,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .await
        .expect("authority");
    assert!(state
        .db
        .update_signing_config(&StoredCaSigningConfig {
            certificate_authority_id: authority_id.clone(),
            organization_id: organization.clone(),
            kind: "root".into(),
            key_algorithm: KeyAlgorithm::EcdsaP256.as_str().to_owned(),
            key_source: "sealed".into(),
            hsm_connector_id: None,
            hsm_key_label: None,
            path_len: None,
            crl_enabled: false,
            crl_mirrors_json: None,
            parent_id: None,
            pending_csr_pem: None,
            version: 1,
        })
        .await
        .expect("signing config"));
    let profile_id = "profile-est-mint".to_owned();
    state
        .db
        .insert_certificate_profile(&StoredCertificateProfile {
            id: profile_id.clone(),
            organization_id: organization.clone(),
            name: "est mint".into(),
            issuer_type: "ca".into(),
            certificate_authority_id: Some(authority_id),
            policy_id,
            defaults_json: "{}".into(),
            external_template: None,
            version: 1,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .await
        .expect("profile");
    let blob = seal_scoped(
        &sealing,
        seal_scopes::EST_PASSPHRASE,
        "est-config:profile-est-mint",
        &organization,
        passphrase.as_bytes(),
    )
    .expect("seal passphrase");
    state
        .db
        .insert_est_config(&StoredEstConfig {
            id: "est-config:profile-est-mint".into(),
            organization_id: organization,
            profile_id: profile_id.clone(),
            sealed_passphrase: Some(SealedCertificateMaterial {
                key_id: "opensesame-connection-key:v1".into(),
                ciphertext: blob.ciphertext,
                nonce: blob.nonce,
                aad_digest: blob.aad_digest,
            }),
            bootstrap_chain_pem: None,
            require_bootstrap: false,
            version: 1,
            created_at: now.clone(),
            updated_at: now,
        })
        .await
        .expect("est config");
    profile_id
}

fn enrollee_csr_der() -> Vec<u8> {
    use base64::Engine as _;
    let key = keys::generate(KeyAlgorithm::EcdsaP256).expect("enrollee key");
    let pem = csr::generate_csr(&SubjectDn::common_name("mint.test"), &[], &key).expect("csr");
    let encoded: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .expect("csr der")
}

fn enroll_request(profile: &str, password: &str, csr_der: Vec<u8>) -> Request<Body> {
    let mut request = Request::post(format!("/.well-known/est/{profile}/simpleenroll"))
        .header(axum::http::header::AUTHORIZATION, basic("est", password))
        .body(Body::from(csr_der))
        .unwrap();
    request.extensions_mut().insert(ListenerProvenance::Tls {
        listener_id: "host".into(),
        policy: TransportPolicy::ServerTls,
        generation: 1,
    });
    request
        .extensions_mut()
        .insert(ConnectInfo("127.0.0.1:1234".parse::<SocketAddr>().unwrap()));
    request
}

#[tokio::test]
async fn admission_without_withdrawal_mints() {
    let _guard = test_env::lock();
    let mut state = sealed_state().await;
    let profile = seed_issuing_profile(&state, "random-value-16b").await;
    install_transport(&mut state);
    let response = router(state)
        .oneshot(enroll_request(
            &profile,
            "random-value-16b",
            enrollee_csr_der(),
        ))
        .await
        .unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
}

#[tokio::test]
async fn source_withdrawn_between_admission_and_issuance_refuses_to_mint() {
    let _guard = test_env::lock();
    let mut state = sealed_state().await;
    let profile = seed_issuing_profile(&state, "random-value-16b").await;
    install_transport(&mut state);
    let organization = state.connection_organization.to_string();
    let (reached, resume) = crate::routes::est_wire::test_pause::install(&organization, "mint");
    let task_state = state.clone();
    let task_profile = profile.clone();
    let task = tokio::spawn(async move {
        router(task_state)
            .oneshot(enroll_request(
                &task_profile,
                "random-value-16b",
                enrollee_csr_der(),
            ))
            .await
            .unwrap()
            .status()
    });
    tokio::time::timeout(StdDuration::from_secs(5), reached)
        .await
        .unwrap()
        .unwrap();
    state
        .transport
        .as_ref()
        .unwrap()
        .generations
        .withdraw(TransportError::GenerationStale);
    resume.send(()).unwrap();
    assert_eq!(task.await.unwrap(), StatusCode::UNAUTHORIZED);
}
