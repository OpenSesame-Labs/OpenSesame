//! Authentication decisions for EST requests.
use super::freshness::evidence_is_current;
#[cfg(test)]
use super::test_pause;
use super::{
    basic_password, freshness, internal, passphrase_budget, passphrase_matches, www_authenticate,
};
use crate::app_state::AppState;
use axum::http::{Extensions, HeaderMap};
use axum::response::Response;
use opensesame_domain::transport::VerifiedPeer;
use opensesame_storage::{StoredCertificateProfile, StoredEstConfig};
use opensesame_transport_security::PeerExtension;
use std::collections::BTreeSet;

/// The basis on which one enrollment attempt was admitted. The mint
/// boundary re-runs the freshness fence for exactly the basis admission
/// used: both bases share the live-transport fence, and the certificate
/// basis must additionally still present current evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::routes) enum Admission {
    /// A verified client certificate the profile accepted.
    Certificate,
    /// The sealed bootstrap passphrase.
    Passphrase,
}

/// Authenticates one enrollment attempt (see the module docs for the rules).
pub(in crate::routes) async fn authenticate(
    st: &AppState,
    headers: &HeaderMap,
    extensions: &Extensions,
    config: &StoredEstConfig,
    profile: &StoredCertificateProfile,
    reenroll: bool,
) -> Result<Admission, Response> {
    let live_transport = || freshness::transport_is_current(st, extensions);
    // Apply the same end-client requirement before BOTH inventory replacement
    // and bootstrap authentication. A proxy can itself be in the inventory;
    // neither that row nor its TLS key proves possession by a downstream client.
    let verified = extensions
        .get::<PeerExtension>()
        .map(|PeerExtension(verified)| verified.as_ref())
        .filter(|verified| evidence_is_current(st, verified));
    let replacing = reenroll
        && match verified {
            Some(verified) => replaces_certificate(st, &profile.organization_id, verified).await?,
            None => false,
        };
    let bootstrap = match verified {
        Some(verified) => bootstrap_ok(st, verified, config)?,
        None => false,
    };
    // Inventory lookups await the database. Rebind the original peer to the
    // exact generation after that await, before accepting certificate auth.
    let certificate_ok = (replacing || bootstrap)
        && verified.is_some_and(|peer| evidence_is_current(st, peer))
        && live_transport();
    if config.require_bootstrap && !certificate_ok {
        return Err(www_authenticate(
            "a client certificate is required at this profile",
        ));
    }
    // Certificate authentication is independent of the password budget: a
    // password guesser must not lock valid certificate holders out of renewal.
    if certificate_ok {
        return Ok(Admission::Certificate);
    }
    let password = basic_password(headers)
        .ok_or_else(|| www_authenticate("valid EST credentials are required"))?;
    if config.sealed_passphrase.is_some() {
        passphrase_budget::reserve(st, config, extensions).await?;
    }
    if passphrase_matches(st, &password, config)? && live_transport() {
        return Ok(Admission::Passphrase);
    }
    Err(www_authenticate("valid EST credentials are required"))
}

/// The mint boundary fence, re-run after the policy and issuer awaits: a
/// source whose trust is withdrawn in that window — or evidence that lapses
/// while the database is awaited — must not still mint. This is the
/// freshness half of the admission proof; the credential proof admission
/// already established is not re-examined here.
pub(in crate::routes) fn mint_fence(
    st: &AppState,
    extensions: &Extensions,
    admission: Admission,
) -> Result<(), Response> {
    let withdrawn = || {
        www_authenticate("the request's transport trust was withdrawn; retry on a fresh connection")
    };
    if !freshness::transport_is_current(st, extensions) {
        return Err(withdrawn());
    }
    if matches!(admission, Admission::Certificate) {
        let current = extensions
            .get::<PeerExtension>()
            .map(|PeerExtension(verified)| verified.as_ref())
            .is_some_and(|verified| evidence_is_current(st, verified));
        if !current {
            return Err(withdrawn());
        }
    }
    Ok(())
}

/// True when the presented certificate is an active certificate of this
/// organization — "the certificate being replaced".
async fn replaces_certificate(
    st: &AppState,
    organization: &str,
    verified: &VerifiedPeer,
) -> Result<bool, Response> {
    let row = st
        .db
        .get_certificate_by_fingerprint(organization, verified.leaf_thumbprint_sha256())
        .await
        .map_err(|error| internal(error, "look up presented certificate"))?;
    #[cfg(test)]
    test_pause::point(organization, "inventory").await;
    Ok(row.is_some_and(|row| row.status == "active"))
}

/// True when the peer is a verified direct-TLS client certificate whose chain
/// was validated against exactly the configured bootstrap chain: the
/// handshake validated the chain (rustls), and this pins *which* anchors it
/// was validated against. With no chain configured, any client certificate
/// the EST listener's trust accepted counts — the listener's `client_trust`
/// is then the operator's bootstrap chain.
fn bootstrap_ok(
    st: &AppState,
    verified: &VerifiedPeer,
    config: &StoredEstConfig,
) -> Result<bool, Response> {
    if let Some(runtime) = &st.transport {
        if runtime
            .generations
            .checked_current(Some(verified.trust_generation()))
            .is_err()
        {
            return Ok(false);
        }
    }
    let Some(chain_pem) = config.bootstrap_chain_pem.as_deref() else {
        return Ok(true);
    };
    let wanted = opensesame_pki_core::bundle::certificates_der(chain_pem)
        .map_err(|error| internal(error, "decode bootstrap chain"))?;
    let Some(runtime) = &st.transport else {
        return Ok(false);
    };
    let Ok(generation) = runtime
        .generations
        .checked_current(Some(verified.trust_generation()))
    else {
        return Ok(false);
    };
    // Bind the anchor snapshot to the evidence even if rotation raced the
    // shared admission check above.
    let Ok(bundle) = generation.trust(verified.trust_profile()) else {
        return Ok(false);
    };
    let anchors: BTreeSet<&[u8]> = bundle
        .anchors()
        .iter()
        .map(std::convert::AsRef::as_ref)
        .collect();
    // VerifiedPeer retains the trust profile, not the accepted certificate path.
    // A subset test would attribute a peer chained to any extra listener CA to
    // this profile's bootstrap CA. Require the complete anchor set to match.
    Ok(wanted.iter().map(Vec::as_slice).collect::<BTreeSet<_>>() == anchors)
}
