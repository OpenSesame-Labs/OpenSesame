//! Mixed mode on the callout profile (`ops/nats/secure-callout.conf`): the
//! Host's service roles are static nkey users in `auth_users` and never
//! reach the callout, while an end user is decided per connection by the
//! (xkey-sealed) callout — both on one server, one account.

use super::live_callout::{connect_as, start_responder};
use super::live_harness::{free_port, Pki, Roles, Server};
use super::live_tests::{backup_config, config, event};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use opensesame_domain::transport::{TrustProfileKind, TrustProfileRef};
use opensesame_transport_security::testkit::{DisposableCa, IssuedLeaf, LeafSpec};
use opensesame_transport_security::TrustBundle;

use crate::nats_connect::{connect_options, BusHealth, InjectedMaterial, NatsRole};
use crate::nats_policy::NatsTransportSource;
use crate::nats_transport::NatsTransportSpec;

use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn service_roles_bypass_the_callout_and_end_users_do_not() {
    if !super::live_harness::enabled() {
        return;
    }
    let pki = Pki::new();
    let roles = Roles::new();
    let issuer = nkeys::KeyPair::new_account();
    let mut env = roles.env(&pki, free_port());
    env.push(("OPENSESAME_NATS_CALLOUT_ISSUER", issuer.public_key()));
    let server = Server::start("secure-callout.conf", &env);
    let url = server.url();

    let admissions = Arc::new(AtomicUsize::new(0));
    let (alice_seed, alice_pub) = super::live_harness::user_nkey();
    start_responder(
        &pki,
        &roles,
        &url,
        issuer,
        alice_pub,
        Arc::clone(&admissions),
    )
    .await;

    // Service roles: provisioning, the Host and the backup consumer all
    // connect on their static nkeys; not one callout is made for them.
    let leaf = pki.client("host.nats.opensesame.test");
    let provisioner_spec = pki.client_spec(Some(&leaf), Some(&roles.provisioner.0), true);
    NatsJetStreamTaskBus::connect(config(
        &url,
        provisioner_spec.clone(),
        NatsRole::Provisioner,
        true,
    ))
    .await
    .unwrap_or_else(|e| panic!("provisioner: {e:#}\n{}", server.log_text()));
    NatsJetStreamTaskBus::connect(backup_config(&url, provisioner_spec, true))
        .await
        .expect("backup consumer provisioned");
    let host = NatsJetStreamTaskBus::connect(config(
        &url,
        pki.client_spec(Some(&leaf), Some(&roles.host.0), true),
        NatsRole::Host,
        false,
    ))
    .await
    .expect("host connects on its static nkey");
    host.publish(event("m1", "principal.created"))
        .await
        .expect("host publishes");
    host.publish(event("m2", "system.backup.wake"))
        .await
        .expect("host publishes a system wake");
    let drained = host.drain(10).await.expect("host drains");
    assert!(drained.iter().any(|e| e.id == "m1"), "{drained:?}");
    let backup = NatsJetStreamTaskBus::connect(backup_config(
        &url,
        pki.client_spec(Some(&leaf), Some(&roles.backup.0), true),
        false,
    ))
    .await
    .expect("backup connects on its static nkey");
    let wakes = backup.drain(10).await.expect("backup drains");
    assert!(wakes.iter().any(|e| e.id == "m2"), "{wakes:?}");
    assert_eq!(
        admissions.load(Ordering::SeqCst),
        0,
        "no service role may depend on the callout"
    );

    observer_may_only_ask_srv(&pki, &roles, &server).await;
    assert_eq!(
        admissions.load(Ordering::SeqCst),
        0,
        "observer bypassed the callout"
    );

    // An end user goes through the sealed callout and gets only what it
    // issued.
    let alice = Box::pin(connect_as(
        &pki,
        &url,
        "alice.nats.opensesame.test",
        &alice_seed,
        Arc::new(BusHealth::default()),
    ))
    .await
    .unwrap_or_else(|e| panic!("alice via callout: {e}\n{}", server.log_text()));
    assert_eq!(admissions.load(Ordering::SeqCst), 1);
    alice
        .publish("opensesame.events.test", "hi".into())
        .await
        .expect("publish");
    alice.flush().await.expect("flush");

    // An unknown nkey is not a service role and is refused by the callout.
    let (mallory_seed, _) = super::live_harness::user_nkey();
    let refused = Box::pin(connect_as(
        &pki,
        &url,
        "mallory.nats.opensesame.test",
        &mallory_seed,
        Arc::new(BusHealth::default()),
    ))
    .await;
    assert!(
        refused.is_err(),
        "an unlisted nkey must go through the callout"
    );
    assert_eq!(admissions.load(Ordering::SeqCst), 2);
}

/// The discovery observer connects on its static nkey and may ask `$SRV`:
/// with no micro service registered the request fails fast with "no
/// responders" — a denied publish would time out instead.
async fn observer_may_only_ask_srv(pki: &Pki, roles: &Roles, server: &Server) {
    let observer = Box::pin(connect_as(
        pki,
        &server.url(),
        "observer.nats.opensesame.test",
        &roles.callout_observer.0,
        Arc::new(BusHealth::default()),
    ))
    .await
    .unwrap_or_else(|e| panic!("observer: {e}\n{}", server.log_text()));
    let ping = tokio::time::timeout(
        Duration::from_secs(5),
        observer.request("$SRV.PING", "".into()),
    )
    .await
    .expect("a permitted $SRV request is answered, not left to time out");
    assert!(
        matches!(&ping, Err(e) if e.kind() == async_nats::RequestErrorKind::NoResponders),
        "{ping:?}"
    );
}

/// A real mTLS NATS server with a SPIFFE server identity and no `NKey` policy.
pub(crate) fn spiffe_server(
    pki: &Pki,
) -> (Server, opensesame_transport_security::testkit::IssuedLeaf) {
    let leaf = pki.ca.issue_with(&LeafSpec::spiffe("spiffe://a.test/nats"));
    let (cert, key) = pki.write_leaf("spiffe-nats", &leaf);
    let port = free_port();
    let quoted = |path: &std::path::Path| serde_json::to_string(&path.to_string_lossy()).unwrap();
    let config = format!(
        "listen: \"127.0.0.1:{port}\"\ntls {{\ncert_file: {}\nkey_file: {}\nca_file: {}\nverify: true\n}}\n",
        quoted(&cert), quoted(&key), quoted(&pki.ca_pem),
    );
    let path = super::live_harness::write(pki.dir.path(), "spiffe-nats.conf", config.as_bytes());
    let server = Server::start(
        path.to_str().unwrap(),
        &[("OPENSESAME_NATS_LISTEN", format!("127.0.0.1:{port}"))],
    );
    (server, leaf)
}

pub(crate) fn spiffe_spec(crl: Option<&std::path::Path>) -> crate::NatsTransportSpec {
    let mut values = HashMap::from([
        (
            "OPENSESAME_NATS_TLS_TRUST_KIND",
            "spiffe_trust_domain".to_owned(),
        ),
        ("OPENSESAME_NATS_TLS_TRUST_DOMAIN", "a.test".to_owned()),
        (
            "OPENSESAME_SPIFFE_ENDPOINT_SOCKET",
            "/tmp/nats-workload.sock".to_owned(),
        ),
        (
            "OPENSESAME_NATS_TLS_SERVER_SPIFFE_ID",
            "spiffe://a.test/nats".to_owned(),
        ),
        ("OPENSESAME_NATS_TLS_IDENTITY_SOURCE", "managed".to_owned()),
        (
            "OPENSESAME_NATS_TLS_MANAGED_CERTIFICATE_ID",
            "nats-test".to_owned(),
        ),
        ("OPENSESAME_NATS_MAX_RECONNECTS", "2".to_owned()),
    ]);
    if let Some(path) = crl {
        values.insert("OPENSESAME_NATS_TLS_CRL_FILE", path.display().to_string());
    }
    crate::NatsTransportSpec::from_lookup("OPENSESAME_NATS", &|key| values.get(key).cloned())
        .unwrap()
        .unwrap()
}

fn environment(expected_domain: &str) -> NatsTransportSpec {
    let values = HashMap::from([
        ("OPENSESAME_NATS_REQUIRE_TLS", "1".to_owned()),
        (
            "OPENSESAME_NATS_TLS_TRUST_KIND",
            "spiffe_trust_domain".to_owned(),
        ),
        ("OPENSESAME_NATS_TLS_TRUST_NAME", "nats-trust".to_owned()),
        ("OPENSESAME_NATS_TLS_TRUST_DOMAIN", "a.test".to_owned()),
        (
            "OPENSESAME_SPIFFE_ENDPOINT_SOCKET",
            "/tmp/workload.sock".to_owned(),
        ),
        (
            "OPENSESAME_NATS_TLS_SERVER_SPIFFE_ID",
            format!("spiffe://{expected_domain}/nats"),
        ),
    ]);
    let spec = NatsTransportSpec::from_lookup("OPENSESAME_NATS", &|key| values.get(key).cloned())
        .unwrap()
        .unwrap();
    assert_eq!(
        spec.transport.server_trust.as_ref().unwrap().kind,
        TrustProfileKind::SpiffeTrustDomain,
        "SPIFFE trust kind must be represented accurately"
    );
    spec.normalized("tls://localhost:4222").unwrap()
}

fn bundle(ca: &DisposableCa, kind: bool, profile: bool, domain: bool) -> TrustBundle {
    let mut value = TrustBundle::from_pem(
        TrustProfileRef::new(if profile { "nats-trust" } else { "other" }).unwrap(),
        if kind {
            TrustProfileKind::SpiffeTrustDomain
        } else {
            TrustProfileKind::PrivateRoot
        },
        &ca.ca_pem(),
    )
    .unwrap();
    if kind {
        value = value
            .with_spiffe_trust_domain(if domain { "a.test" } else { "b.test" })
            .unwrap();
    }
    value
}

pub(crate) async fn options(spec: &NatsTransportSpec, injected: &InjectedMaterial) -> bool {
    connect_options(
        spec,
        NatsRole::Publisher,
        injected,
        Arc::new(BusHealth::default()),
    )
    .await
    .is_ok()
}

pub(crate) async fn assert_stored_spiffe_profile(
    ca: &DisposableCa,
    spec: &NatsTransportSpec,
    trust: TrustBundle,
    dns_only: IssuedLeaf,
) {
    let foreign = ca.issue_with(&LeafSpec::spiffe("spiffe://other.test/host"));
    assert!(
        !options(
            spec,
            &InjectedMaterial {
                trust: Some(trust.clone()),
                identity: Some(Arc::new(foreign.identity())),
            }
        )
        .await,
        "a different client trust domain is refused"
    );

    // A stored public reference has no private SPIFFE-ID locator to compare.
    let stored = NatsTransportSpec::from_public(spec.public(), NatsTransportSource::Stored)
        .normalized("tls://localhost:4222")
        .unwrap();
    let mut invalid_profile = LeafSpec::spiffe("spiffe://client.test/host");
    invalid_profile.server_auth = false;
    for invalid in [dns_only, ca.issue_with(&invalid_profile)] {
        assert!(
            !options(
                &stored,
                &InjectedMaterial {
                    trust: Some(trust.clone()),
                    identity: Some(Arc::new(invalid.identity())),
                },
            )
            .await,
            "stored SPIFFE identity requires a valid SVID profile"
        );
    }
    let other = ca.issue_with(&LeafSpec::spiffe("spiffe://client.test/other"));
    assert!(
        options(
            &stored,
            &InjectedMaterial {
                trust: Some(trust),
                identity: Some(Arc::new(other.identity())),
            },
        )
        .await,
        "stored policy with no identity locator cannot compare an absent ID"
    );
}

pub(crate) fn bit(value: &str) -> bool {
    match value {
        "0" => false,
        "1" => true,
        _ => panic!("invalid formal vector bit"),
    }
}

#[tokio::test]
#[ignore = "requires Lean vectors; run spec/formal/source-trust-selection/verify.sh"]
async fn lean_vectors_match_nats_injection() {
    let path = std::env::var("OPENSESAME_SOURCE_SELECTION_VECTORS").expect("run verifier");
    let vectors = std::fs::read_to_string(path).expect("read selector vectors");
    let ca = DisposableCa::new("nats-injection-vectors");
    let mut seen = HashSet::new();
    let mut compared = 0;
    for line in vectors.lines() {
        let fields: Vec<_> = line.split('\t').collect();
        let ["source", fresh, present, kind, profile, domain, expected] = fields.as_slice() else {
            panic!("invalid selector vector: {line}");
        };
        let (fresh, present, kind, profile, domain, expected) = (
            bit(fresh),
            bit(present),
            bit(kind),
            bit(profile),
            bit(domain),
            bit(expected),
        );
        assert!(
            seen.insert((fresh, present, kind, profile, domain)),
            "duplicate selector input"
        );
        if !fresh || !present {
            continue;
        }
        let injected = InjectedMaterial {
            trust: Some(bundle(&ca, kind, profile, domain)),
            identity: None,
        };
        // The ID follows the injected domain here so only the environment
        // locator can refuse A-configured/B-injected/B-expected.
        let from_env = environment(if domain { "a.test" } else { "b.test" });
        assert_eq!(
            options(&from_env, &injected).await,
            expected,
            "environment vector {line}"
        );
        // Stored public policy has no locator; the expected SPIFFE ID
        // supplies the comparison domain instead.
        let from_store = NatsTransportSpec::from_public(
            environment("a.test").public(),
            NatsTransportSource::Stored,
        )
        .normalized("tls://localhost:4222")
        .unwrap();
        assert_eq!(
            options(&from_store, &injected).await,
            expected,
            "stored vector {line}"
        );
        compared += 2;
    }
    assert_eq!(seen.len(), 32, "incomplete selector vector matrix");
    assert_eq!(compared, 16, "incomplete NATS vector comparison");
}
