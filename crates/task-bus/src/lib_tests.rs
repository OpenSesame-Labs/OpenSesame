//! Unit tests for the crate root (memory bus, subjects, backend selection).

use super::*;
use serde_json::json;

fn sample_event(id: &str) -> BusEvent {
    BusEvent::cloud_event(
        id,
        "opensesame/test",
        "principal.created",
        "2026-08-17T00:00:00Z",
        json!({"principal_id": "prn_1"}),
    )
}

#[tokio::test]
async fn in_memory_publish_drain_fifo() {
    let bus = InMemoryTaskBus::default();
    bus.publish(sample_event("1")).await.unwrap();
    bus.publish(sample_event("2")).await.unwrap();
    let batch = bus.drain(1).await.unwrap();
    assert_eq!(batch.len(), 1);
    assert_eq!(batch[0].id, "1");
    let rest = bus.drain(10).await.unwrap();
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0].id, "2");
    assert!(bus.drain(10).await.unwrap().is_empty());
}

#[test]
fn event_subject_joins_prefix_and_type() {
    assert_eq!(
        event_subject("opensesame.events", "credential.rotation.requested"),
        "opensesame.events.credential.rotation.requested"
    );
    assert_eq!(
        sample_event("x").subject(DEFAULT_SUBJECT_PREFIX),
        "opensesame.events.principal.created"
    );
}

#[test]
fn backend_from_env_matrix() {
    let saved_taskbus = std::env::var_os("OPENSESAME_TASKBUS");
    let saved_nats = std::env::var_os("NATS_URL");
    let restore = || {
        match &saved_taskbus {
            Some(v) => std::env::set_var("OPENSESAME_TASKBUS", v),
            None => std::env::remove_var("OPENSESAME_TASKBUS"),
        }
        match &saved_nats {
            Some(v) => std::env::set_var("NATS_URL", v),
            None => std::env::remove_var("NATS_URL"),
        }
    };

    std::env::remove_var("OPENSESAME_TASKBUS");
    std::env::remove_var("NATS_URL");
    assert_eq!(TaskBusBackend::from_env().unwrap(), TaskBusBackend::Memory);

    std::env::set_var("NATS_URL", "nats://127.0.0.1:4222");
    assert_eq!(TaskBusBackend::from_env().unwrap(), TaskBusBackend::Nats);

    std::env::set_var("OPENSESAME_TASKBUS", "memory");
    assert_eq!(TaskBusBackend::from_env().unwrap(), TaskBusBackend::Memory);

    std::env::set_var("OPENSESAME_TASKBUS", "nats");
    assert!(TaskBusBackend::from_env().is_ok());

    std::env::remove_var("NATS_URL");
    assert!(TaskBusBackend::from_env().is_err());

    std::env::set_var("OPENSESAME_TASKBUS", "bogus");
    assert!(TaskBusBackend::from_env().is_err());

    restore();
}

#[cfg(feature = "jetstream")]
#[test]
fn failed_and_old_connections_cannot_change_active_health() {
    use crate::nats_connect::BusHealth;
    use async_nats::Event;
    let observer = BusHealth::default();
    let first = BusHealth::default();
    first.record(&Event::Connected);
    observer.adopt(&first);
    let failed = BusHealth::default();
    failed.record(&Event::Connected);
    failed.record(&Event::Closed);
    assert!(observer.connected());
    assert_eq!(observer.last_event().as_deref(), Some("connected"));
    let second = BusHealth::default();
    second.record(&Event::Connected);
    observer.adopt(&second);
    first.record(&Event::Closed);
    assert!(observer.connected());
    assert_eq!(observer.disconnects(), 0);
    assert_eq!(observer.reconnects(), 1);
    let pending = BusHealth::default();
    observer.adopt(&pending);
    pending.record(&Event::Connected);
    assert_eq!(observer.reconnects(), 2, "delayed event");
    second.record(&Event::Disconnected);
    assert!(observer.connected());
    pending.record(&Event::Disconnected);
    assert!(!observer.connected());
    assert_eq!(observer.disconnects(), 1);
}

#[cfg(feature = "jetstream")]
#[test]
fn stored_tls_requirements_cannot_resolve_to_plaintext() {
    use opensesame_domain::transport::{TransportError, TrustProfileKind};
    for transport in [
        NatsTransport {
            server_trust: Some(TrustRef {
                name: "nats-trust".into(),
                kind: TrustProfileKind::PrivateRoot,
            }),
            ..NatsTransport::default()
        },
        NatsTransport {
            server_name: Some(NatsServerName::Dns("localhost".into())),
            ..NatsTransport::default()
        },
        NatsTransport {
            min_version: opensesame_domain::transport::TlsVersion::Tls12,
            ..NatsTransport::default()
        },
    ] {
        let stored = NatsTransportSpec::from_public(
            NatsTransportPublic {
                transport,
                auth: NatsAuth::None,
            },
            NatsTransportSource::Stored,
        );
        assert!(matches!(
            stored.normalized("nats://localhost:4222"),
            Err(TransportError::PolicyDowngradeRefused)
        ));
    }
}

#[cfg(feature = "jetstream")]
#[test]
fn contradictory_nats_security_sources_are_refused() {
    use opensesame_domain::transport::TransportError;
    use std::collections::HashMap;

    let cases: &[(&str, &[(&str, &str)])] = &[
        (
            "SPIFFE trust with file",
            &[
                ("TLS_TRUST_KIND", "spiffe_trust_domain"),
                ("TLS_TRUST_DOMAIN", "a.test"),
                ("TLS_TRUST_FILE", "/ca"),
                ("SOCKET", "/socket"),
            ],
        ),
        (
            "PEM trust with domain",
            &[
                ("TLS_TRUST_KIND", "private_root"),
                ("TLS_TRUST_FILE", "/ca"),
                ("TLS_TRUST_DOMAIN", "a.test"),
            ],
        ),
        (
            "PEM identity with managed ID",
            &[
                ("TLS_IDENTITY_SOURCE", "pem"),
                ("TLS_CERT_FILE", "/cert"),
                ("TLS_KEY_FILE", "/key"),
                ("TLS_MANAGED_CERTIFICATE_ID", "managed"),
            ],
        ),
        (
            "managed identity with certificate",
            &[
                ("TLS_IDENTITY_SOURCE", "managed"),
                ("TLS_MANAGED_CERTIFICATE_ID", "managed"),
                ("TLS_CERT_FILE", "/cert"),
            ],
        ),
        (
            "SPIFFE identity with key",
            &[
                ("TLS_IDENTITY_SOURCE", "spiffe"),
                ("TLS_SPIFFE_ID", "spiffe://a.test/client"),
                ("TLS_KEY_FILE", "/key"),
                ("SOCKET", "/socket"),
            ],
        ),
        (
            "nkey with creds",
            &[
                ("AUTH", "nkey"),
                ("NKEY_SEED_FILE", "/seed"),
                ("CREDS_FILE", "/creds"),
            ],
        ),
        (
            "creds with nkey",
            &[
                ("AUTH", "creds"),
                ("NKEY_SEED_FILE", "/seed"),
                ("CREDS_FILE", "/creds"),
            ],
        ),
        (
            "provisioning credentials conflict",
            &[
                ("PROVISION_AUTH", "creds"),
                ("PROVISION_NKEY_SEED_FILE", "/seed"),
                ("PROVISION_CREDS_FILE", "/creds"),
            ],
        ),
    ];
    for (label, vars) in cases {
        let map: HashMap<String, String> = vars
            .iter()
            .map(|(name, value)| {
                let name = if *name == "SOCKET" {
                    "OPENSESAME_SPIFFE_ENDPOINT_SOCKET".to_owned()
                } else {
                    format!("OPENSESAME_NATS_{name}")
                };
                (name, (*value).to_owned())
            })
            .collect();
        let result =
            NatsTransportSpec::from_lookup("OPENSESAME_NATS", &|name| map.get(name).cloned());
        assert!(
            matches!(result, Err(TransportError::MalformedConfiguration(_))),
            "conflicting NATS source must be refused: {label}"
        );
    }
    assert_valid_nats_sources();
}

#[cfg(feature = "jetstream")]
fn assert_valid_nats_sources() {
    use std::collections::HashMap;
    let compatible = HashMap::from([
        ("OPENSESAME_NATS_TLS_TRUST_KIND", "spiffe_trust_domain"),
        ("OPENSESAME_NATS_TLS_TRUST_DOMAIN", "a.test"),
        ("OPENSESAME_SPIFFE_ENDPOINT_SOCKET", "/socket"),
        ("OPENSESAME_NATS_TLS_IDENTITY_SOURCE", "managed"),
        ("OPENSESAME_NATS_TLS_MANAGED_CERTIFICATE_ID", "managed"),
        ("OPENSESAME_NATS_AUTH", "nkey"),
        ("OPENSESAME_NATS_NKEY_SEED_FILE", "/seed"),
        ("OPENSESAME_NATS_PROVISION_AUTH", "creds"),
        ("OPENSESAME_NATS_PROVISION_CREDS_FILE", "/creds"),
    ]);
    assert!(
        NatsTransportSpec::from_lookup("OPENSESAME_NATS", &|name| compatible
            .get(name)
            .map(ToString::to_string))
        .unwrap()
        .is_some(),
        "independent primary and provisioning sources remain supported"
    );
    let spiffe_identity = HashMap::from([
        ("OPENSESAME_NATS_TLS_IDENTITY_SOURCE", "spiffe"),
        ("OPENSESAME_NATS_TLS_SPIFFE_ID", "spiffe://a.test/client"),
        ("OPENSESAME_SPIFFE_ENDPOINT_SOCKET", "/socket"),
    ]);
    let spec = NatsTransportSpec::from_lookup("OPENSESAME_NATS", &|name| {
        spiffe_identity.get(name).map(ToString::to_string)
    })
    .unwrap()
    .unwrap();
    assert_eq!(
        spec.transport.client_identity.unwrap().kind,
        opensesame_domain::transport::IdentitySourceKind::SpiffeWorkloadApi,
        "SPIFFE identity kind must be represented accurately"
    );
}

#[cfg(feature = "jetstream")]
#[test]
fn mutated_public_policy_cannot_ignore_security_locators() {
    use opensesame_domain::transport::TransportError;
    use std::collections::HashMap;

    let values = HashMap::from([
        ("OPENSESAME_NATS_AUTH", "nkey"),
        ("OPENSESAME_NATS_NKEY_SEED_FILE", "/seed"),
    ]);
    let spec = NatsTransportSpec::from_lookup("OPENSESAME_NATS", &|name| {
        values.get(name).map(ToString::to_string)
    })
    .unwrap()
    .unwrap();
    let mut anonymous = spec.clone();
    anonymous.auth = NatsAuth::None;
    assert!(
        matches!(
            anonymous.normalized("nats://localhost:4222"),
            Err(TransportError::IdentityMissing)
        ),
        "credential locator must not be silently ignored"
    );
    let mut other_kind = spec;
    other_kind.auth = NatsAuth::Creds {
        path_ref: "other".into(),
    };
    assert!(
        matches!(
            other_kind.normalized("nats://localhost:4222"),
            Err(TransportError::EnforcementUnsupported)
        ),
        "credential locator kind must match the public policy"
    );
    let values = HashMap::from([
        ("OPENSESAME_NATS_AUTH", "creds"),
        ("OPENSESAME_NATS_CREDS_FILE", "/creds"),
    ]);
    let mut other_kind = NatsTransportSpec::from_lookup("OPENSESAME_NATS", &|name| {
        values.get(name).map(ToString::to_string)
    })
    .unwrap()
    .unwrap();
    other_kind.auth = NatsAuth::Nkey {
        seed_ref: "other".into(),
    };
    assert!(
        matches!(
            other_kind.normalized("nats://localhost:4222"),
            Err(TransportError::EnforcementUnsupported)
        ),
        "nkey policy must not ignore a creds locator"
    );
    let mut crl = NatsTransportSpec::from_lookup("OPENSESAME_NATS", &|name| {
        (name == "OPENSESAME_NATS_TLS_CRL_FILE").then(|| "/crl".to_owned())
    })
    .unwrap()
    .unwrap();
    crl.transport.require_tls = false;
    assert!(
        matches!(
            crl.normalized("nats://localhost:4222"),
            Err(TransportError::PolicyDowngradeRefused)
        ),
        "CRL locator must not be silently ignored"
    );
    let values = HashMap::from([
        ("OPENSESAME_NATS_PROVISION_AUTH", "creds"),
        ("OPENSESAME_NATS_PROVISION_CREDS_FILE", "/creds"),
    ]);
    let mut provision = NatsTransportSpec::from_lookup("OPENSESAME_NATS", &|name| {
        values.get(name).map(ToString::to_string)
    })
    .unwrap()
    .unwrap();
    provision.transport.require_tls = false;
    assert!(
        matches!(
            provision.normalized("nats://localhost:4222"),
            Err(TransportError::PolicyDowngradeRefused)
        ),
        "provisioning credential locator must not be silently ignored"
    );
}
