//! The EST wire mechanics behind `est_server`: profile loading without a
//! session, RFC 7030 authentication, CSR body decoding, and the issuer glue.
//!
//! Authentication rules, stated once:
//!
//! - **the certificate being replaced** (re-enrollment only): a verified TLS
//!   client certificate whose leaf fingerprint matches an active inventory row
//!   for this organization;
//! - **bootstrap certificate**: a verified `DirectTls` client certificate
//!   whose chain was validated at the handshake against exactly the
//!   operator-uploaded `bootstrap_chain_pem` (pinned here by comparing that
//!   chain to the anchors of the peer's trust profile);
//! - **passphrase**: HTTP Basic (RFC 7030 §4.2.2), the password compared in
//!   constant time to the sealed `est_passphrase`.
//!
//! `require_bootstrap` makes a client certificate mandatory *in addition* to
//! whatever else matched: the passphrase alone must never enroll.
//! Certificate authentication requires direct end-client mTLS. Trusted-ingress
//! peers prove the proxy's key; originating assertions are not an EST proof.

use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine as _;
use opensesame_connection_broker::crypto::{open_scoped, SealedBlob};
use opensesame_storage::{StoredCertificateProfile, StoredEstConfig};
use serde_json::json;

use super::est_server::{internal, refuse, sealing_key, KEY_ID, MIN_PASSPHRASE_BYTES};
use crate::app_state::AppState;

/// The sealing scope CA keys live under (mirrors `certmgr_ca`).
const CA_SCOPE: &str = "certificate_authority";

#[path = "est_auth.rs"]
mod auth;
pub(super) use auth::{authenticate, mint_fence};

#[path = "est_freshness.rs"]
mod freshness;

#[cfg(test)]
#[path = "est_test_pause.rs"]
pub(super) mod test_pause;

#[path = "est_passphrase_budget.rs"]
mod passphrase_budget;

/// Loads the profile by its protocol-path id and its EST configuration.
/// A missing profile and a missing configuration are the same `404`: the
/// endpoint is unauthenticated and must not be an existence oracle.
pub(super) async fn load_profile(
    st: &AppState,
    profile_id: &str,
) -> Result<(StoredCertificateProfile, StoredEstConfig), Response> {
    let unavailable = || {
        refuse(
            StatusCode::NOT_FOUND,
            "unavailable",
            "no enrollment is configured at this path",
        )
    };
    let profile = st
        .db
        .get_certificate_profile_by_id(profile_id)
        .await
        .map_err(|error| internal(error, "read profile"))?
        .ok_or_else(unavailable)?;
    let config = st
        .db
        .get_est_config(&profile.organization_id, profile_id)
        .await
        .map_err(|error| internal(error, "read est config"))?
        .ok_or_else(unavailable)?;
    Ok((profile, config))
}

/// HTTP Basic password check against the sealed passphrase, constant time.
fn passphrase_matches(
    st: &AppState,
    password: &str,
    config: &StoredEstConfig,
) -> Result<bool, Response> {
    let Some(material) = config.sealed_passphrase.as_ref() else {
        return Ok(false);
    };
    if material.key_id != KEY_ID {
        return Ok(false);
    }
    let sealing = sealing_key(st)?;
    let opened = zeroize::Zeroizing::new(
        open_scoped(
            &sealing,
            opensesame_storage::seal_scopes::EST_PASSPHRASE,
            &config.id,
            &config.organization_id,
            &SealedBlob {
                ciphertext: material.ciphertext.clone(),
                nonce: material.nonce.clone(),
                aad_digest: material.aad_digest.clone(),
            },
        )
        .map_err(|error| internal(error, "open est passphrase"))?,
    );
    // Existing weak credentials are disabled too: throttling a persistent
    // four-digit password must not leave it guessable over successive windows.
    // A valid certificate has already authenticated before reaching this path.
    Ok(opened.len() >= MIN_PASSPHRASE_BYTES && constant_time_eq(&opened, password.as_bytes()))
}

/// The password half of an HTTP Basic credential (RFC 7617). The user name is
/// ignored by design: the profile's passphrase is the credential.
fn basic_password(headers: &HeaderMap) -> Option<String> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let encoded = value.strip_prefix("Basic ")?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    let text = String::from_utf8(decoded).ok()?;
    text.split_once(':')
        .map(|(_, password)| password.to_owned())
}

/// Length-independent byte comparison.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = a.len() ^ b.len();
    for (left, right) in a.iter().zip(b.iter()) {
        diff |= usize::from(left ^ right);
    }
    diff == 0
}

fn www_authenticate(hint: &'static str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(
            axum::http::header::WWW_AUTHENTICATE,
            r#"Basic realm="est", charset="UTF-8""#,
        )],
        Json(json!({"error": "unauthorized", "hint": hint})),
    )
        .into_response()
}

/// RFC 7030 bodies are base64 (`Content-Transfer-Encoding: base64`); raw DER
/// is accepted too since the content type says PKCS#10 either way.
pub(super) fn decode_csr_body(body: &[u8]) -> Result<Vec<u8>, Response> {
    let bad = || {
        refuse(
            StatusCode::BAD_REQUEST,
            "csr_invalid",
            "the body must be a PKCS#10 request (DER or base64)",
        )
    };
    if body.is_empty() {
        return Err(bad());
    }
    if body[0] == 0x30 {
        return Ok(body.to_vec());
    }
    base64::engine::general_purpose::STANDARD
        .decode(body)
        .map_err(|_| bad())
}

/// The certificate document a stored authority carries.
fn authority_certificate(
    authority: &opensesame_storage::StoredCertificateAuthority,
) -> Result<String, Response> {
    serde_json::from_str::<serde_json::Value>(&authority.public_metadata_json)
        .ok()
        .and_then(|document| {
            document
                .get("certificate")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        })
        .ok_or_else(|| {
            refuse(
                StatusCode::SERVICE_UNAVAILABLE,
                "issuer_unavailable",
                "the profile's authority has no certificate document",
            )
        })
}

/// The chain a `cacerts` response distributes: the issuing certificate (and,
/// when its document carries one, its parent chain).
pub(super) async fn ca_chain_pem(
    st: &AppState,
    profile: &StoredCertificateProfile,
) -> Result<String, Response> {
    let (authority, _) = load_authority(st, profile).await?;
    let mut chain = authority_certificate(&authority)?;
    if let Ok(document) = serde_json::from_str::<serde_json::Value>(&authority.public_metadata_json)
    {
        if let Some(parents) = document.get("chain").and_then(|value| value.as_str()) {
            chain.push('\n');
            chain.push_str(parents);
        }
    }
    Ok(chain)
}

/// Loads the profile's issuing authority certificate and key pair out of
/// sealed custody.
pub(super) async fn load_issuer(
    st: &AppState,
    profile: &StoredCertificateProfile,
) -> Result<(String, opensesame_pki_core::keys::KeyPair), Response> {
    use std::str::FromStr as _;
    let (authority, config) = load_authority(st, profile).await?;
    let certificate = authority_certificate(&authority)?;
    if authority.sealed_material.key_id != KEY_ID {
        return Err(refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "issuer_unavailable",
            "this authority was sealed with a key id this build cannot open",
        ));
    }
    let algorithm = opensesame_pki_core::types::KeyAlgorithm::from_str(&config.key_algorithm)
        .map_err(|_| internal("unknown key algorithm", "open certificate authority key"))?;
    let sealing = sealing_key(st)?;
    let plaintext = open_scoped(
        &sealing,
        CA_SCOPE,
        &authority.id,
        &authority.organization_id,
        &SealedBlob {
            ciphertext: authority.sealed_material.ciphertext.clone(),
            nonce: authority.sealed_material.nonce.clone(),
            aad_digest: authority.sealed_material.aad_digest.clone(),
        },
    )
    .map_err(|error| internal(error, "open certificate authority key"))?;
    let pem = String::from_utf8(plaintext)
        .map_err(|error| internal(error, "decode certificate authority key"))?;
    let key = opensesame_pki_core::keys::from_pkcs8_pem(&pem, algorithm)
        .map_err(|error| internal(error, "import certificate authority key"))?;
    Ok((certificate, key))
}

async fn load_authority(
    st: &AppState,
    profile: &StoredCertificateProfile,
) -> Result<
    (
        opensesame_storage::StoredCertificateAuthority,
        opensesame_storage::StoredCaSigningConfig,
    ),
    Response,
> {
    let authority_id = profile.certificate_authority_id.as_deref().ok_or_else(|| {
        refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "issuer_unavailable",
            "this profile has no issuing authority; self-signed profiles do not enroll over EST",
        )
    })?;
    let authority = st
        .db
        .get_certificate_authority(&profile.organization_id, authority_id)
        .await
        .map_err(|error| internal(error, "read certificate authority"))?
        .ok_or_else(|| {
            refuse(
                StatusCode::SERVICE_UNAVAILABLE,
                "issuer_unavailable",
                "the profile's authority is gone; nothing is issued",
            )
        })?;
    let config = st
        .db
        .get_signing_config(&profile.organization_id, authority_id)
        .await
        .map_err(|error| internal(error, "read signing config"))?
        .ok_or_else(|| {
            refuse(
                StatusCode::SERVICE_UNAVAILABLE,
                "issuer_unavailable",
                "the profile's authority has no signing configuration",
            )
        })?;
    Ok((authority, config))
}
