//! Real-server suites against the pinned nats-server (`#[ignore]`; run with
//! `OPENSESAME_MTLS_FIXTURES=1`): client mTLS admission, downgrade refusal,
//! the role matrix, system-subject denial, and identity rotation.

use super::live_harness::{secure_server, Pki, Roles};
use super::*;
use crate::nats_transport::NatsTransportSpec;
use opensesame_domain::transport::TransportError;
use serde_json::json;
use std::time::Duration;

pub(crate) fn config(
    url: &str,
    spec: NatsTransportSpec,
    role: NatsRole,
    provision: bool,
) -> NatsJetStreamConfig {
    NatsJetStreamConfig {
        nats_url: url.to_owned(),
        transport: spec,
        role,
        provision,
        fetch_expires: Duration::from_millis(500),
        ..NatsJetStreamConfig::default()
    }
}

pub(crate) async fn direct_nats_reconnect(pki: &Pki, injected: InjectedMaterial) {
    use super::live_callout::wait_for_reconnect_limit;
    use super::live_mixed::{spiffe_server, spiffe_spec};

    let (server, _) = spiffe_server(pki);
    let mut spec = spiffe_spec(None);
    spec.max_reconnects = Some(1);
    let bus = NatsJetStreamTaskBus::connect_with(
        config(&server.url(), spec.clone(), NatsRole::Publisher, false),
        injected.clone(),
    )
    .await
    .unwrap();
    let old = bus.session.read().await.client.clone();
    old.force_reconnect().await.unwrap();
    wait_for_reconnect_limit(&bus.health()).await;
    Box::pin(bus.rotate(spec, Some(injected)))
        .await
        .expect("direct NATS rotation");
    let fresh = bus.session.read().await.client.clone();
    fresh.flush().await.unwrap();
}

pub(crate) fn backup_config(
    url: &str,
    spec: NatsTransportSpec,
    provision: bool,
) -> NatsJetStreamConfig {
    NatsJetStreamConfig {
        consumer_name: crate::BACKUP_CONSUMER_NAME.into(),
        filter_subject: Some(format!("{}.>", crate::SYSTEM_SUBJECT_PREFIX)),
        ..config(url, spec, NatsRole::Backup, provision)
    }
}

/// Take the error from a call that must fail (`expect_err` needs `Debug` on
/// the success type, which the bus deliberately does not implement).
pub(crate) fn must_fail<T>(result: anyhow::Result<T>, what: &str) -> anyhow::Error {
    match result {
        Ok(_) => panic!("{what}"),
        Err(error) => error,
    }
}

pub(crate) fn event(id: &str, ty: &str) -> BusEvent {
    BusEvent::cloud_event(
        id,
        "opensesame/live-test",
        ty,
        "2026-09-22T00:00:00Z",
        json!({"ok": true}),
    )
}

fn is_tls_failure(error: &anyhow::Error) -> bool {
    let text = format!("{error:#}").to_ascii_lowercase();
    text.contains("tls")
        || text.contains("certificate")
        || text.contains("handshake")
        || text.contains("alert")
}

#[tokio::test]
#[ignore = "requires Lean vectors; run spec/formal/source-trust-selection/verify.sh --nats"]
async fn injected_spiffe_client_matches_locator_and_profile() {
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;

    use opensesame_domain::transport::{PeerIdentitySelector, TrustProfileKind, TrustProfileRef};
    use opensesame_transport_security::testkit::{DisposableCa, LeafSpec};
    use opensesame_transport_security::TrustBundle;

    use crate::nats::live_mixed::{assert_stored_spiffe_profile, bit, options};
    use crate::nats_connect::InjectedMaterial;

    let values = HashMap::from([
        ("OPENSESAME_NATS_REQUIRE_TLS", "1"),
        ("OPENSESAME_NATS_TLS_TRUST_KIND", "spiffe_trust_domain"),
        ("OPENSESAME_NATS_TLS_TRUST_NAME", "nats-trust"),
        ("OPENSESAME_NATS_TLS_TRUST_DOMAIN", "server.test"),
        (
            "OPENSESAME_NATS_TLS_SERVER_SPIFFE_ID",
            "spiffe://server.test/nats",
        ),
        ("OPENSESAME_NATS_TLS_IDENTITY_SOURCE", "spiffe"),
        ("OPENSESAME_NATS_TLS_SPIFFE_ID", "spiffe://client.test/host"),
        ("OPENSESAME_SPIFFE_ENDPOINT_SOCKET", "/tmp/workload.sock"),
    ]);
    let spec = NatsTransportSpec::from_lookup("OPENSESAME_NATS", &|key| {
        values.get(key).map(ToString::to_string)
    })
    .unwrap()
    .unwrap()
    .normalized("tls://localhost:4222")
    .unwrap();
    let ca = DisposableCa::new("nats-client-svid");
    let trust = TrustBundle::from_pem(
        TrustProfileRef::new("nats-trust").unwrap(),
        TrustProfileKind::SpiffeTrustDomain,
        &ca.ca_pem(),
    )
    .unwrap()
    .with_spiffe_trust_domain("server.test")
    .unwrap();

    let path = std::env::var("OPENSESAME_NATS_CLIENT_VECTORS").expect("run NATS verifier");
    let vectors = std::fs::read_to_string(path).expect("read client SVID vectors");
    let mut seen = HashSet::new();
    for line in vectors.lines() {
        let fields: Vec<_> = line.split('\t').collect();
        let ["client-svid", matching, profile, expected] = fields.as_slice() else {
            panic!("invalid client SVID vector: {line}");
        };
        let (matching, profile, expected) = (bit(matching), bit(profile), bit(expected));
        assert!(
            seen.insert((matching, profile)),
            "duplicate client SVID input"
        );
        let id = if matching {
            "spiffe://client.test/host"
        } else {
            "spiffe://client.test/other"
        };
        let mut leaf = LeafSpec::spiffe(id);
        leaf.server_auth = profile;
        let injected = InjectedMaterial {
            trust: Some(trust.clone()),
            identity: Some(Arc::new(ca.issue_with(&leaf).identity())),
        };
        assert_eq!(
            options(&spec, &injected).await,
            expected,
            "configured client ID and SVID profile: {id}, profile={profile}"
        );
    }
    assert_eq!(seen.len(), 4, "incomplete client SVID vector matrix");

    let dns_only = ca.issue_client(PeerIdentitySelector::DnsName("client.test".into()));
    assert!(
        !options(
            &spec,
            &InjectedMaterial {
                trust: Some(trust.clone()),
                identity: Some(Arc::new(dns_only.identity())),
            },
        )
        .await,
        "a DNS-only certificate is not an SVID"
    );

    assert_stored_spiffe_profile(&ca, &spec, trust, dns_only).await;
}

/// AT-NATS-NOCERT: no client certificate → refused in the TLS handshake,
/// before any NATS authentication happens.
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn no_client_certificate_is_refused_by_tls() {
    if !super::live_harness::enabled() {
        return;
    }
    let pki = Pki::new();
    let roles = Roles::new();
    let server = secure_server(&pki, &roles);
    let spec = pki.client_spec(None, Some(&roles.host.0), false);
    let error = NatsJetStreamTaskBus::connect(config(&server.url(), spec, NatsRole::Host, false))
        .await
        .err()
        .expect("must not connect without a client certificate");
    let text = format!("{error:#}").to_ascii_lowercase();
    assert!(is_tls_failure(&error), "expected a TLS failure, got {text}");
    assert!(
        !text.contains("authorization violation"),
        "refused at TLS, not at auth: {text}"
    );
}

/// AT-NATS-NOCERT (untrusted): a certificate from another CA → TLS refusal.
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn untrusted_client_certificate_is_refused_by_tls() {
    if !super::live_harness::enabled() {
        return;
    }
    let pki = Pki::new();
    let roles = Roles::new();
    let server = secure_server(&pki, &roles);
    let stranger =
        pki.other_ca
            .issue_client(opensesame_domain::transport::PeerIdentitySelector::DnsName(
                "stranger".into(),
            ));
    let spec = pki.client_spec(Some(&stranger), Some(&roles.host.0), false);
    let error = NatsJetStreamTaskBus::connect(config(&server.url(), spec, NatsRole::Host, false))
        .await
        .err()
        .expect("must not connect with an untrusted certificate");
    assert!(is_tls_failure(&error), "{error:#}");
}

/// AT-NATS-DOWNGRADE: a plaintext broker and a wrong-identity broker are
/// both refused by the secure profile; the bus is unavailable, never
/// memory, never plaintext.
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn plaintext_or_wrong_identity_server_is_refused() {
    if !super::live_harness::enabled() {
        return;
    }
    let pki = Pki::new();
    let roles = Roles::new();
    let leaf = pki.client("host.nats.opensesame.test");

    // 1. A plaintext broker (the local-dev profile) on the same host name.
    let plain_port = super::live_harness::free_port();
    let plain = super::live_harness::Server::start_with_args(
        "local-dev.conf",
        &[("OPENSESAME_NATS_LISTEN", format!("127.0.0.1:{plain_port}"))],
        &[
            "-a".into(),
            "127.0.0.1".into(),
            "-p".into(),
            plain_port.to_string(),
        ],
    );
    let spec = pki.client_spec(Some(&leaf), Some(&roles.host.0), false);
    let error =
        NatsJetStreamTaskBus::connect(config(&plain.url(), spec.clone(), NatsRole::Host, false))
            .await
            .err()
            .expect("secure profile must refuse a plaintext broker");
    assert!(
        is_tls_failure(&error) || format!("{error:#}").to_ascii_lowercase().contains("io"),
        "{error:#}"
    );
    drop(plain);

    // 2. A TLS broker whose certificate comes from an unrelated CA.
    let wrong = {
        let other = pki.other_ca.issue_server(super::live_harness::SERVER_NAME);
        let (cert, key) = pki.write_leaf("wrong-server", &other);
        let port = super::live_harness::free_port();
        let mut env = roles.env(&pki, port);
        env.retain(|(k, _)| {
            *k != "OPENSESAME_NATS_TLS_SERVER_CERT" && *k != "OPENSESAME_NATS_TLS_SERVER_KEY"
        });
        env.push((
            "OPENSESAME_NATS_TLS_SERVER_CERT",
            cert.display().to_string(),
        ));
        env.push(("OPENSESAME_NATS_TLS_SERVER_KEY", key.display().to_string()));
        super::live_harness::Server::start("secure-client.conf", &env)
    };
    let error =
        NatsJetStreamTaskBus::connect(config(&wrong.url(), spec.clone(), NatsRole::Host, false))
            .await
            .err()
            .expect("secure profile must refuse a broker with a wrong certificate");
    assert!(is_tls_failure(&error), "{error:#}");

    // 3. A `nats://` URL beside the secure profile is a downgrade, refused
    //    before any connection is attempted.
    let error = NatsJetStreamTaskBus::connect(config(
        &format!("nats://localhost:{}", wrong.port),
        spec,
        NatsRole::Host,
        false,
    ))
    .await
    .err()
    .expect("nats:// with a secure profile is still TLS-required");
    assert!(
        is_tls_failure(&error) || error.downcast_ref::<TransportError>().is_some(),
        "{error:#}"
    );
}

/// NAT-LIFECYCLE: rotate the client identity; the durable consumer keeps
/// its name and its sequence, and the old connection is drained.
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn identity_rotation_keeps_the_durable_consumer() {
    if !super::live_harness::enabled() {
        return;
    }
    let pki = Pki::new();
    let roles = Roles::new();
    let server = secure_server(&pki, &roles);
    let url = server.url();
    let first = pki.client("gen1.nats.opensesame.test");
    let second = pki.client("gen2.nats.opensesame.test");

    let prov = NatsJetStreamTaskBus::connect(config(
        &url,
        pki.client_spec(Some(&first), Some(&roles.provisioner.0), false),
        NatsRole::Provisioner,
        true,
    ))
    .await
    .expect("provision");
    drop(prov);
    let host = NatsJetStreamTaskBus::connect(config(
        &url,
        pki.client_spec(Some(&first), Some(&roles.host.0), false),
        NatsRole::Host,
        false,
    ))
    .await
    .expect("host");
    host.publish(event("r1", "principal.created"))
        .await
        .expect("publish");
    let before = host.consumer_info().await.expect("info");
    assert_eq!(before.name, crate::DEFAULT_CONSUMER_NAME);
    let old_server_id = host.server_id().await;

    Box::pin(host.rotate(
        pki.client_spec(Some(&second), Some(&roles.host.0), false),
        None,
    ))
    .await
    .expect("rotate to the second identity");
    assert_eq!(host.server_id().await, old_server_id);
    host.publish(event("r2", "principal.created"))
        .await
        .expect("publish after rotation");
    let drained = host.drain(10).await.expect("drain after rotation");
    assert!(
        drained.iter().any(|e| e.id == "r1") && drained.iter().any(|e| e.id == "r2"),
        "{drained:?}"
    );
    let after = host.consumer_info().await.expect("info after");
    assert_eq!(after.name, before.name);
    assert!(
        after.delivered.stream_sequence > before.delivered.stream_sequence,
        "{after:?}"
    );
    assert_eq!(
        after.config.durable_name.as_deref(),
        Some(crate::DEFAULT_CONSUMER_NAME)
    );

    // A rotation to an untrusted identity fails and leaves the old session.
    let stranger =
        pki.other_ca
            .issue_client(opensesame_domain::transport::PeerIdentitySelector::DnsName(
                "stranger".into(),
            ));
    assert!(Box::pin(host.rotate(
        pki.client_spec(Some(&stranger), Some(&roles.host.0), false),
        None
    ))
    .await
    .is_err());
    host.publish(event("r3", "principal.created"))
        .await
        .expect("old session still serves");
}
