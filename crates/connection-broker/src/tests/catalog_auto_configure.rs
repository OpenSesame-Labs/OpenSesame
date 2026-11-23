//! Auto-configured and identity connectors: readiness and sealed configuration.

use super::*;

#[tokio::test]
async fn zero_input_native_connectors_are_ready_without_user_configuration() {
    let (_db, broker) = broker().await;
    let organization = OrganizationId::new();
    let owner = "prn_local_owner";

    assert_eq!(
        broker
            .auto_configure_connections(&organization, Some(owner))
            .await,
        2
    );
    let connections = broker
        .list_connections_for(&organization, Some(owner))
        .await
        .unwrap();
    let providers = connections
        .iter()
        .map(|connection| connection.provider_id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        providers,
        std::collections::BTreeSet::from(["plain", "sealed-local"])
    );
    let automatic = broker
        .list_providers()
        .unwrap()
        .into_iter()
        .filter(|provider| provider.auto_configurable)
        .map(|provider| provider.id)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        automatic,
        std::collections::BTreeSet::from(["plain".into(), "sealed-local".into()])
    );
    assert!(connections
        .iter()
        .all(|connection| connection.status == ConnectionStatus::Active));
    assert!(!serde_json::to_string(&connections)
        .unwrap()
        .contains("opensesame://sealed-local"));
}

#[tokio::test]
async fn identity_connectors_seal_their_declared_configuration() {
    let (_db, broker) = broker().await;
    let org = OrganizationId::new();

    let better_auth = broker
        .create_connection(&org, create("better-auth"))
        .await
        .unwrap();
    let active = broker
        .set_connection_configuration(
            &org,
            &better_auth.connection_id,
            std::collections::BTreeMap::from([
                (
                    "base_url".into(),
                    "https://auth.example.com/api/auth".into(),
                ),
                ("api_key".into(), "do-not-return".into()),
                ("api_key_header".into(), "x-api-key".into()),
                ("config_id".into(), "default".into()),
            ]),
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(active.status, ConnectionStatus::Active);
    assert!(!serde_json::to_string(&active)
        .unwrap()
        .contains("do-not-return"));

    let auth0 = broker
        .create_connection(&org, create("auth0"))
        .await
        .unwrap();
    let active = broker
        .set_connection_configuration(
            &org,
            &auth0.connection_id,
            std::collections::BTreeMap::from([
                ("domain".into(), "tenant.us.auth0.com".into()),
                ("client_id".into(), "client".into()),
                ("client_secret".into(), "also-do-not-return".into()),
                (
                    "audience".into(),
                    "https://tenant.us.auth0.com/api/v2/".into(),
                ),
            ]),
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(active.status, ConnectionStatus::Active);
    assert!(!serde_json::to_string(&active)
        .unwrap()
        .contains("also-do-not-return"));
}
