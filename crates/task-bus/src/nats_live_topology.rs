//! AT-NATS-TOPOLOGY on the pinned server: TLS-first handshake, the
//! `verify_and_map` profile, the 2-node TLS-route cluster (right and wrong
//! route certificates), and discovery not widening egress.

use super::live_harness::{free_port, secure_server, Pki, Roles, Server, SERVER_NAME};
use super::live_mixed::{spiffe_server, spiffe_spec};
use super::*;
use crate::nats_connect::load_material;
use opensesame_domain::transport::{PeerIdentitySelector, TrustProfileKind, TrustProfileRef};
use opensesame_transport_security::TrustBundle;
use std::time::Duration;

pub(crate) fn cluster_env(
    pki: &Pki,
    roles: &Roles,
    port: u16,
    cluster_port: u16,
    route_to: u16,
    route: &(std::path::PathBuf, std::path::PathBuf),
    route_ca: &std::path::Path,
) -> Vec<(&'static str, String)> {
    let mut env = roles.env(pki, port);
    env.retain(|(k, _)| {
        !k.starts_with("OPENSESAME_NATS_NKEY_") || *k == "OPENSESAME_NATS_NKEY_HOST"
    });
    env.extend([
        (
            "OPENSESAME_NATS_CLUSTER_LISTEN",
            format!("127.0.0.1:{cluster_port}"),
        ),
        (
            "OPENSESAME_NATS_ROUTE_URL",
            format!("nats-route://127.0.0.1:{route_to}"),
        ),
        ("OPENSESAME_NATS_ROUTE_CERT", route.0.display().to_string()),
        ("OPENSESAME_NATS_ROUTE_KEY", route.1.display().to_string()),
        ("OPENSESAME_NATS_ROUTE_CA", route_ca.display().to_string()),
    ]);
    env
}

fn assert_crl_material(
    pki: &Pki,
    revoked: &opensesame_transport_security::testkit::IssuedLeaf,
    spec: &NatsTransportSpec,
    base: &NatsTransportSpec,
    injected: &InjectedMaterial,
) -> InjectedMaterial {
    let path = pki.dir.path().join("configured.crl");
    let trust = injected.trust.as_ref().unwrap().clone();
    let identity = Arc::clone(injected.identity.as_ref().unwrap());
    assert!(
        load_material(spec, injected).is_err(),
        "missing CRL refused"
    );
    std::fs::write(&path, b"").unwrap();
    assert!(load_material(spec, injected).is_err(), "empty CRL refused");
    std::fs::write(
        &path,
        b"-----BEGIN X509 CRL-----\nAAAA\n-----END X509 CRL-----\n",
    )
    .unwrap();
    assert!(
        load_material(spec, injected).is_err(),
        "malformed CRL refused"
    );

    let revoked_crl = pki.ca.crl_pem(&[revoked]);
    std::fs::write(
        &path,
        [b"-----BEGIN X509 CRL-----\n".as_slice(), &revoked_crl].concat(),
    )
    .unwrap();
    assert!(
        load_material(spec, injected).is_err(),
        "truncated CRL before another BEGIN must be refused"
    );
    std::fs::write(&path, [&revoked_crl[..], &revoked_crl[..]].concat()).unwrap();
    assert!(
        matches!(
            load_material(spec, injected),
            Err(opensesame_domain::transport::TransportError::EnforcementUnsupported)
        ),
        "multiple configured CRLs must be refused"
    );
    std::fs::write(&path, &revoked_crl).unwrap();
    let preserved = InjectedMaterial {
        trust: Some(trust.with_crls(&revoked_crl).unwrap()),
        identity: Some(Arc::clone(&identity)),
    };
    assert!(
        matches!(
            load_material(spec, &preserved),
            Err(opensesame_domain::transport::TransportError::EnforcementUnsupported)
        ),
        "configured and injected CRLs must not be combined"
    );
    let existing = load_material(base, &preserved).unwrap().trust.unwrap();
    assert_eq!(existing.crls(), preserved.trust.as_ref().unwrap().crls());
    let doubled = InjectedMaterial {
        trust: Some(
            preserved
                .trust
                .as_ref()
                .unwrap()
                .clone()
                .with_crls(&revoked_crl)
                .unwrap(),
        ),
        identity: Some(Arc::clone(&identity)),
    };
    assert!(
        matches!(
            load_material(base, &doubled),
            Err(opensesame_domain::transport::TransportError::EnforcementUnsupported)
        ),
        "multiple injected CRLs must be refused"
    );

    preserved
}

/// A configured CRL must constrain injected trust on the actual NATS TLS
/// handshake. Independently supplied CRL sets cannot safely be merged by
/// webpki, which selects only the first authoritative CRL.
#[tokio::test]
#[ignore = "requires the pinned NATS fixture"]
async fn injected_trust_enforces_configured_crls() {
    assert!(
        super::live_harness::enabled(),
        "set OPENSESAME_MTLS_FIXTURES=1"
    );
    let pki = Pki::new();
    let (server, revoked) = spiffe_server(&pki);
    let leaf = pki.client("publisher.nats.opensesame.test");
    let identity = Arc::new(leaf.try_identity().unwrap());
    let base = spiffe_spec(None);
    let trust = TrustBundle::from_pem(
        TrustProfileRef::new("nats-server-trust").unwrap(),
        TrustProfileKind::SpiffeTrustDomain,
        &pki.ca.ca_pem(),
    )
    .unwrap()
    .with_spiffe_trust_domain("a.test")
    .unwrap();
    let injected = InjectedMaterial {
        trust: Some(trust),
        identity: Some(identity),
    };
    let path = pki.dir.path().join("configured.crl");
    let spec = spiffe_spec(Some(&path));
    let preserved = assert_crl_material(&pki, &revoked, &spec, &base, &injected);
    let connect = |policy, material| {
        NatsJetStreamTaskBus::connect_with(
            config(&server.url(), policy, NatsRole::Publisher, false),
            material,
        )
    };
    assert!(
        connect(spec.clone(), injected.clone()).await.is_err(),
        "configured CRL revokes server"
    );
    assert!(
        connect(base.clone(), preserved).await.is_err(),
        "injected CRL revokes server"
    );
    std::fs::write(&path, pki.ca.crl_pem(&[])).unwrap();
    assert!(
        connect(spec, injected).await.is_ok(),
        "unrevoked server remains usable"
    );

    let crl_only = NatsTransportSpec::from_lookup("OPENSESAME_NATS", &|name| {
        (name == "OPENSESAME_NATS_TLS_CRL_FILE").then(|| "/configured.crl".to_owned())
    })
    .unwrap()
    .unwrap();
    assert!(crl_only.is_secure(), "CRL alone implies TLS");
    assert!(
        crl_only.normalized("nats://localhost:4222").is_err(),
        "trust is required"
    );
}

pub(crate) fn config(
    url: &str,
    spec: crate::nats_transport::NatsTransportSpec,
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

/// `tls { handshake_first: true }` (secure-callout.conf carries it): a
/// client with `tls_first` connects; the log shows the TLS handshake
/// before INFO; a client without `tls_first` cannot connect at all.
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn tls_first_handshake_is_supported_and_required_by_the_profile() {
    if !super::live_harness::enabled() {
        return;
    }
    let pki = Pki::new();
    let roles = Roles::new();
    let port = free_port();
    let issuer = nkeys::KeyPair::new_account();
    let mut env = roles.env(&pki, port);
    env.push(("OPENSESAME_NATS_CALLOUT_ISSUER", issuer.public_key()));
    let server = Server::start("secure-callout.conf", &env);
    let leaf = pki.client("callout.nats.opensesame.test");

    // The callout responder identity is a static AUTH user: it connects
    // without a callout round trip, which is all this test needs.
    let spec = pki.client_spec(Some(&leaf), Some(&roles.callout.0), true);
    let bus =
        NatsJetStreamTaskBus::connect(config(&server.url(), spec, NatsRole::Publisher, false))
            .await
            .expect("tls_first client connects to a handshake_first server");
    assert!(
        super::live_harness::wait_until(|| bus.health().connected(), Duration::from_secs(5)).await,
        "the tls_first client never reported Connected"
    );
    assert!(
        server.wait_log("TLS handshake complete", Duration::from_secs(3)),
        "log: {}",
        server.log_text()
    );
    let log = server.log_text();
    let handshake = log
        .find("TLS handshake complete")
        .expect("handshake logged");
    let info = log
        .find("->> [INFO")
        .or_else(|| log.find("INFO {"))
        .unwrap_or(usize::MAX);
    assert!(
        handshake < info,
        "handshake must precede the INFO line: {log}"
    );

    let spec = pki.client_spec(Some(&leaf), Some(&roles.callout.0), false);
    let error = NatsJetStreamTaskBus::connect(config(
        &server.url(),
        spec,
        NatsRole::Publisher,
        false,
    ))
    .await
    .err()
    .expect("a client that waits for INFO before TLS cannot connect to a handshake_first server");
    assert!(!format!("{error:#}").is_empty());
}

/// `verify_and_map: true`: a certificate whose SAN is listed becomes that
/// user; a certificate from the same CA with an unlisted SAN is refused
/// (authorization violation, not a TLS failure).
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn verify_and_map_admits_listed_sans_only() {
    if !super::live_harness::enabled() {
        return;
    }
    let pki = Pki::new();
    let port = free_port();
    let prov_san = "provisioner.nats.opensesame.test";
    let host_san = "host.nats.opensesame.test";
    let env = vec![
        ("OPENSESAME_NATS_LISTEN", format!("127.0.0.1:{port}")),
        ("OPENSESAME_NATS_SERVER_NAME", format!("map-{port}")),
        (
            "OPENSESAME_NATS_TLS_SERVER_CERT",
            pki.server_cert.display().to_string(),
        ),
        (
            "OPENSESAME_NATS_TLS_SERVER_KEY",
            pki.server_key.display().to_string(),
        ),
        (
            "OPENSESAME_NATS_TLS_CLIENT_CA",
            pki.ca_pem.display().to_string(),
        ),
        ("OPENSESAME_NATS_MAP_PROVISIONER", prov_san.to_owned()),
        ("OPENSESAME_NATS_MAP_HOST", host_san.to_owned()),
    ];
    let server = Server::start("secure-verify-and-map.conf", &env);
    let url = server.url();

    let prov = NatsJetStreamTaskBus::connect(config(
        &url,
        pki.client_spec(Some(&pki.client(prov_san)), None, false),
        NatsRole::Provisioner,
        true,
    ))
    .await
    .expect("mapped provisioner SAN provisions");
    drop(prov);
    let host = NatsJetStreamTaskBus::connect(config(
        &url,
        pki.client_spec(Some(&pki.client(host_san)), None, false),
        NatsRole::Host,
        false,
    ))
    .await
    .expect("mapped host SAN connects");
    host.publish(BusEvent::cloud_event(
        "m1",
        "t",
        "principal.created",
        "2026-09-22T00:00:00Z",
        serde_json::json!({}),
    ))
    .await
    .expect("mapped host publishes");

    let unlisted = pki.client("someone-else.nats.opensesame.test");
    let error = NatsJetStreamTaskBus::connect(config(
        &url,
        pki.client_spec(Some(&unlisted), None, false),
        NatsRole::Host,
        false,
    ))
    .await
    .err()
    .expect("an unlisted SAN from the same CA is not a user");
    let text = format!("{error:#}").to_ascii_lowercase();
    assert!(
        text.contains("authorization") || text.contains("auth"),
        "{text}"
    );
    assert!(
        server.wait_log("Authorization Violation", Duration::from_secs(2))
            || server.log_text().contains("authorization"),
        "{}",
        server.log_text()
    );
}

/// Sanity for every shipped template: `nats-server -t` accepts it with the
/// environment the live suite provides (a template drift fails here first).
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn every_shipped_template_passes_config_check() {
    if !super::live_harness::enabled() {
        return;
    }
    let pki = Pki::new();
    let roles = Roles::new();
    let route = pki.write_leaf("route-check", &Pki::route_leaf(&pki.ca));
    let issuer = nkeys::KeyPair::new_account();
    let mut env = cluster_env(
        &pki,
        &roles,
        free_port(),
        free_port(),
        free_port(),
        &route,
        &pki.ca_pem,
    );
    env.extend(roles.env(&pki, free_port()));
    env.push(("OPENSESAME_NATS_CALLOUT_ISSUER", issuer.public_key()));
    env.push(("OPENSESAME_NATS_MAP_PROVISIONER", "p.example".into()));
    env.push(("OPENSESAME_NATS_MAP_HOST", "h.example".into()));
    env.push((
        "OPENSESAME_NATS_STORE_DIR",
        pki.dir.path().join("js").display().to_string(),
    ));
    for conf in [
        "local-dev.conf",
        "secure-client.conf",
        "secure-verify-and-map.conf",
        "secure-routes.conf",
        "secure-callout.conf",
    ] {
        let out = std::process::Command::new(super::live_harness::server_bin())
            .arg("-t")
            .arg("-c")
            .arg(super::live_harness::ops_conf(conf))
            .envs(env.iter().map(|(k, v)| (*k, v.as_str())))
            .output()
            .expect("nats-server -t");
        assert!(
            out.status.success(),
            "{conf}: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let _ = PeerIdentitySelector::DnsName(SERVER_NAME.into());
    let _ = secure_server;
}
