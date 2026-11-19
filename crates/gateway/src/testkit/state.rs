//! Explicit test state: no deployment configuration is read from the process.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use opensesame_audit::{ReceiptSigner, ReceiptVerifier};
use opensesame_broker::Broker;
use opensesame_connection_broker::{BrokerConfig, ConnectionBroker};
use opensesame_domain::OrganizationId;
use opensesame_host_core::deployment_mode::{Deployment, DeploymentMode, ExposureClass};
use opensesame_session_observe::NoRunCredentials;
use opensesame_storage::Db;
use opensesame_task_bus::InMemoryTaskBus;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::app_state::AppState;

pub(super) async fn build() -> anyhow::Result<AppState> {
    let db = Db::connect_memory().await?;
    let organization = OrganizationId::new();
    db.create_organization(&organization, "isolated test organization")
        .await?;
    let signer = ReceiptSigner::generate();
    let mut verifier = ReceiptVerifier::new();
    verifier.trust(signer.verifying_key());
    let broker = Broker {
        db: db.clone(),
        policy: opensesame_authz::PolicyEngine::default(),
        host: opensesame_connector_host::HostRuntime::default(),
        signer,
    };
    // With no key or provider configuration, this cannot store or acquire
    // credentials. The fixture mounts read-only routes only.
    let broker_config = BrokerConfig::in_memory(None, "http://127.0.0.1:1");
    let connection_broker = Arc::new(ConnectionBroker::new_without_system_proxy(
        db.pool().clone(),
        broker_config,
    )?);
    let secret = || format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    Ok(AppState {
        deployment: Deployment {
            mode: DeploymentMode::Test,
            exposure: ExposureClass::LocalOnly,
        },
        identity_mapping: None,
        host_authorization: None,
        client_app_url: Some(url::Url::parse("https://pages.test/OpenSesame/").unwrap()),
        resource: "https://host.test".into(),
        issuer: "https://identity.test".into(),
        db,
        broker: Arc::new(broker),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        session_channels: Arc::new(Mutex::new(HashMap::new())),
        github_app_pending: Arc::new(Mutex::new(HashMap::new())),
        claims: Arc::new(Mutex::new(HashMap::new())),
        public_enrollment: Arc::new(Mutex::default()),
        claim_user_code_attempts: Arc::new(Mutex::new(HashMap::new())),
        bootstrap: Arc::new(Mutex::new(None)),
        openfga: None,
        openbao: None,
        connection_ref: None,
        connection_broker,
        relay_presence: Arc::new(Mutex::new(HashMap::new())),
        ephemeral_certificate_ca: Arc::new(Mutex::new(None)),
        connection_organization: organization,
        operator_token: secret(),
        claim_pepper: secret(),
        distributed_task_authority: false,
        task_engine: crate::task_engine::new_task_engine(),
        frozen_intents: Arc::new(Mutex::new(HashMap::new())),
        receipt_verifier: Arc::new(verifier),
        backup_notify: Arc::new(tokio::sync::Notify::new()),
        sync_notify: Arc::new(tokio::sync::Notify::new()),
        task_bus: Arc::new(RwLock::new(Arc::new(InMemoryTaskBus::default()))),
        transport_lifecycle: crate::transport_lifecycle::LifecycleState::new(),
        transport: None,
        web_login_runs: Arc::new(crate::web_login::registry::RunRegistry::new(
            crate::web_login::registry::RunLimits::default(),
        )),
        agent_hook_approver: None,
        run_credentials: Arc::new(NoRunCredentials),
    })
}
