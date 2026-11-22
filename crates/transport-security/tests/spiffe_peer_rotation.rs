//! Authenticated SPIFFE sessions cannot reuse an old domain after rotation.
mod common;

use std::sync::Arc;
use std::time::Duration;

use common::*;
use opensesame_domain::transport::{TlsVersion, TransportPolicy};
use opensesame_transport_security::testkit::{DisposableCa, IssuedLeaf};
use opensesame_transport_security::{GenerationCandidate, ServerProfile, TransportGenerations};
use rustls::pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer};
use secrecy::ExposeSecret;

const OLD_ID: &str = "spiffe://old.example/workload";
const NEW_ID: &str = "spiffe://new.example/workload";

fn client(server: &DisposableCa, leaf: &IssuedLeaf, tls12: bool) -> Arc<rustls::ClientConfig> {
    let versions: &[&rustls::SupportedProtocolVersion] = if tls12 {
        &[&rustls::version::TLS12]
    } else {
        &[&rustls::version::TLS13]
    };
    let certs = CertificateDer::pem_slice_iter(&leaf.cert_pem)
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let key = PrivateKeyDer::from_pem_slice(leaf.key_pem.expose_secret()).unwrap();
    Arc::new(
        rustls::ClientConfig::builder_with_provider(opensesame_transport_security::provider())
            .with_protocol_versions(versions)
            .unwrap()
            .with_root_certificates(private_root("servers", server).roots())
            .with_client_auth_cert(certs, key)
            .unwrap(),
    )
}

fn candidate(
    identity: &Arc<opensesame_transport_security::TlsIdentity>,
    authority: &DisposableCa,
    domain: &str,
) -> GenerationCandidate {
    let trust = spiffe_bundle("peers", authority)
        .with_spiffe_trust_domain(domain)
        .unwrap();
    GenerationCandidate {
        identity: Some(Arc::clone(identity)),
        peer_trust: [(profile_ref("peers"), trust)].into(),
        own_trust: None,
        identity_required: true,
    }
}

async fn exercise(policy: TransportPolicy, tls12: bool, source_owned: bool) {
    let server = DisposableCa::new("server");
    let authority = DisposableCa::new("clients");
    let identity = Arc::new(server.issue_server("localhost").identity());
    let initial = candidate(&identity, &authority, "old.example");
    let generations =
        TransportGenerations::new(initial.into_generation(1, opensesame_time::Utc::now()).unwrap());
    let owner = generations.source_owner();
    let epoch = if source_owned {
        let claim = generations.claim_source(&owner).unwrap();
        Some(
            generations
                .activate_from_source(
                    &owner,
                    claim,
                    candidate(&identity, &authority, "old.example"),
                )
                .unwrap(),
        )
    } else {
        None
    };
    let listener = serve(
        Arc::clone(&generations),
        move |generation| {
            let identity = generation.identity.clone().unwrap();
            let mut profile = ServerProfile::new(policy, identity, LISTENER);
            profile.client_trust = Some(generation.trust(&profile_ref("peers"))?.clone());
            profile.min_version = TlsVersion::Tls12;
            Ok(profile)
        },
        router(Arc::clone(&generations), Hits::default()),
    )
    .await;
    let old_client = client(&server, &authority.issue_spiffe(OLD_ID), tls12);
    let mut first = connect(Arc::clone(&old_client), listener.addr, localhost())
        .await
        .unwrap();
    assert_eq!(request_on(&mut first, "/protected").await.unwrap().0, 200);
    assert_eq!(
        first.get_ref().1.handshake_kind(),
        Some(rustls::HandshakeKind::Full)
    );
    // Read the first response before reconnecting so a TLS 1.3 ticket, if
    // one were incorrectly issued, can enter the client's session cache.
    let mut second = connect(Arc::clone(&old_client), listener.addr, localhost())
        .await
        .unwrap();
    assert_eq!(request_on(&mut second, "/protected").await.unwrap().0, 200);
    let connection = second.get_ref().1;
    assert_eq!(
        connection.handshake_kind(),
        Some(rustls::HandshakeKind::Full)
    );
    assert_eq!(
        connection.protocol_version(),
        Some(if tls12 {
            rustls::ProtocolVersion::TLSv1_2
        } else {
            rustls::ProtocolVersion::TLSv1_3
        })
    );
    let replacement = candidate(&identity, &authority, "new.example");
    if let Some(epoch) = epoch {
        generations
            .activate_from_source(&owner, epoch, replacement)
            .unwrap();
    } else {
        generations.activate(replacement).unwrap();
    }
    assert_eq!(request_on(&mut first, "/protected").await.unwrap().0, 403);
    if let Ok(mut old) = connect(old_client, listener.addr, localhost()).await {
        assert!(request_on(&mut old, "/protected").await.is_err());
    }
    let new_client = client(&server, &authority.issue_spiffe(NEW_ID), tls12);
    let mut fresh = connect(new_client, listener.addr, localhost())
        .await
        .unwrap();
    assert_eq!(request_on(&mut fresh, "/protected").await.unwrap().0, 200);
    assert_eq!(
        fresh.get_ref().1.handshake_kind(),
        Some(rustls::HandshakeKind::Full)
    );
    assert_eq!(listener.counters.resumed(), 0);
}

#[tokio::test]
async fn spiffe_domain_rotation_requires_fresh_client_authentication() {
    for policy in [
        TransportPolicy::MtlsRequired,
        TransportPolicy::TrustedIngress,
    ] {
        for (tls12, source_owned) in [(false, false), (false, true), (true, false), (true, true)] {
            tokio::time::timeout(
                Duration::from_secs(15),
                exercise(policy, tls12, source_owned),
            )
            .await
            .expect("SPIFFE rotation test timed out");
        }
    }
}
