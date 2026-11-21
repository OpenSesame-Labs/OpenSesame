//! Real `SQLite`, Workload API, and manager coverage for source history.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use opensesame_spiffe_source::fake::{FakeTrustDomain, FakeWorkloadApi, IssuedSvid};
use opensesame_spiffe_source::{SourcePhase, SpiffeSource, SpiffeSourceConfig, SpiffeSourceHandle};
use opensesame_transport_security::env::{NativeIdentitySpec, NativeTrustSpec};
use tokio::sync::{mpsc, Semaphore};

use crate::transport::test_support::{local_bundle, local_candidate};

use super::*;

const TD: &str = "example.test";
const ID: &str = "spiffe://example.test/opensesame/gateway";

fn config(api: &FakeWorkloadApi) -> SpiffeSourceConfig {
    SpiffeSourceConfig::deployment_plane(ID, api.socket_path())
        .unwrap()
        .with_max_stale(Duration::from_secs(5))
}

fn snapshot(
    td: &FakeTrustDomain,
    gateway: &IssuedSvid,
    partner: Option<&FakeTrustDomain>,
) -> opensesame_spiffe_source::fake::pb::X509svidResponse {
    let federated = partner.map_or_else(Vec::new, |ca| vec![("partner.test", ca.bundle_der())]);
    FakeWorkloadApi::snapshot(vec![gateway.to_proto(&td.bundle_der(), "")], &federated)
}

async fn streaming_after(handle: &SpiffeSourceHandle, prior: u64) -> u64 {
    handle
        .wait_for(Duration::from_secs(5), |status| {
            status.phase == SourcePhase::Streaming && status.generation.is_some_and(|n| n > prior)
        })
        .await
        .expect("source did not activate")
        .generation
        .unwrap()
}

async fn initialized(db: &Db, scope: &Arc<Scope>) {
    let document = br#"{"owner":"host-tls","actor":"operator","change_ref":"change-1","names":[]}"#;
    acquire(Arc::clone(scope))
        .await
        .unwrap()
        .initialize(db.clone(), document.to_vec(), true)
        .await
        .unwrap();
}

struct PauseAfterCommit {
    inner: Arc<CoordinatedHistory>,
    calls: AtomicUsize,
    committed: mpsc::UnboundedSender<()>,
    finished: mpsc::UnboundedSender<()>,
    release: Arc<Semaphore>,
}

impl GenerationHistory for PauseAfterCommit {
    fn reserve(&self, names: BTreeSet<TrustProfileRef>) -> Result<HistoryWrite, TransportError> {
        let write = self.inner.reserve(names)?;
        if self.calls.fetch_add(1, Ordering::SeqCst) != 1 {
            return Ok(write);
        }
        let committed = self.committed.clone();
        let finished = self.finished.clone();
        let release = Arc::clone(&self.release);
        let worker = tokio::spawn(async move {
            write.await?;
            let _ = committed.send(());
            release.acquire_owned().await.unwrap().forget();
            let _ = finished.send(());
            Ok(())
        });
        Ok(Box::pin(async move {
            worker
                .await
                .map_err(|_| TransportError::SourceUnsupported)?
        }))
    }
}

async fn event(rx: &mut mpsc::UnboundedReceiver<()>) {
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("write barrier was not reached")
        .expect("write barrier closed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn committed_unpublished_name_survives_same_manager_owner_handoff() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let url = format!("sqlite:{}", file.path().display());
    let db = Db::connect_sqlite(&url).await.unwrap();
    let scope = Arc::new(Scope::default());
    initialized(&db, &scope).await;
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let partner = FakeTrustDomain::new("partner.test");
    let gateway = td.issue_svid(ID, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &gateway, None));
    let managed = acquire(scope)
        .await
        .unwrap()
        .start_manager(db.clone(), GenerationCandidate::default())
        .await
        .unwrap();
    let generations = managed.generations();
    let (committed_tx, mut committed) = mpsc::unbounded_channel();
    let (finished_tx, mut finished) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let history = Arc::new(PauseAfterCommit {
        inner: Arc::clone(&managed.adapter),
        calls: AtomicUsize::new(0),
        committed: committed_tx,
        finished: finished_tx,
        release: Arc::clone(&release),
    });
    let sink = Arc::new(TransportGenerationsSink::with_history(
        Arc::clone(&generations),
        history,
    ));
    let cfg = config(&api);
    let old = SpiffeSource::start(cfg.clone(), sink).unwrap();
    let previous = streaming_after(&old, 0).await;
    api.push_snapshot(snapshot(&td, &gateway, Some(&partner)));
    event(&mut committed).await;
    assert!(load(&db)
        .await
        .unwrap()
        .names()
        .contains(&TrustProfileRef::new("partner.test").unwrap()));
    drop(old);
    assert!(generations.checked_current(None).is_err());

    api.push_snapshot(snapshot(&td, &gateway, None));
    let successor = SpiffeSource::start(cfg, Arc::new(managed.source_sink())).unwrap();
    let current = streaming_after(&successor, previous).await;
    let mut colliding = local_candidate(&generations);
    colliding.peer_trust.insert(
        TrustProfileRef::new("partner.test").unwrap(),
        local_bundle("partner.test", &partner),
    );
    assert_eq!(
        generations.activate(colliding),
        Err(TransportError::GenerationStale)
    );
    release.add_permits(1);
    event(&mut finished).await;
    assert!(generations.checked_current(Some(current)).is_ok());
    successor.stop().await;
    api.shutdown().await;
}

use crate::transport::config::TransportConfig;
use crate::transport::managed::NoManagedIdentity;
use crate::transport::test_support::{
    assert_missing_history, history_configs, wait_for_history_owner, ManagedIdentity,
};
use crate::transport::{ManagedIdentityResolver, TransportRuntime};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn initialized_host_retains_source_names_across_restart_and_pem_transition() {
    let dir = tempfile::tempdir().unwrap();
    let url = format!("sqlite:{}?mode=rwc", dir.path().join("host.db").display());
    // This is the normal Host database opening path, including migrations.
    let db = opensesame_storage::Db::connect_sqlite(&url).await.unwrap();
    let api = FakeWorkloadApi::start();
    let domain = FakeTrustDomain::new("example.test");
    let partner = FakeTrustDomain::new("partner.test");
    let id = "spiffe://example.test/opensesame/gateway";
    let svid = domain.issue_svid(id, Duration::from_mins(10));
    api.push_snapshot(snapshot(&domain, &svid, Some(&partner)));
    let mut source_config = crate::transport::test_support::mtls_config();
    let listener = source_config.listener.as_mut().unwrap();
    listener.identity = NativeIdentitySpec::Spiffe {
        spiffe_id: id.into(),
        endpoint_socket: api.socket_path().into(),
    };
    listener.client_trust = Some(NativeTrustSpec::SpiffeTrustDomain {
        trust_domain: "example.test".into(),
        endpoint_socket: api.socket_path().into(),
    });
    listener.client_trust_profile = TrustProfileRef::new("example.test").unwrap();
    let (pem_config, managed_config, managed_resolver, bindings_only) = history_configs(dir.path());
    for (config, resolver) in [
        (
            source_config.clone(),
            &NoManagedIdentity as &dyn ManagedIdentityResolver,
        ),
        (pem_config.clone(), &NoManagedIdentity),
        (managed_config.clone(), &managed_resolver),
        (bindings_only.clone(), &NoManagedIdentity),
    ] {
        assert_missing_history(config, &db, resolver).await;
    }

    let db = exercise_source_restart(db, &url, &api, &domain, &partner, &svid, source_config).await;
    exercise_local_sources(
        &db,
        pem_config,
        managed_config,
        &managed_resolver,
        bindings_only,
    )
    .await;
    api.shutdown().await;
}

#[tokio::test]
async fn attested_history_blocks_pem_collision_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let url = format!("sqlite:{}?mode=rwc", dir.path().join("host.db").display());
    let db = opensesame_storage::Db::connect_sqlite(&url).await.unwrap();
    let document = br#"{"owner":"host-tls","actor":"operator","change_ref":"upgrade","names":["partner.test"]}"#;
    crate::transport::source_history::coordinator::initialize_host_history(
        &url,
        document.to_vec(),
        true,
    )
    .await
    .unwrap();
    db.pool().close().await;
    drop(db);

    let reopened = opensesame_storage::Db::connect_sqlite(&url).await.unwrap();
    let (pem, managed, resolver, bindings_only) = history_configs(dir.path());
    exercise_local_sources(&reopened, pem, managed, &resolver, bindings_only).await;
}

async fn exercise_source_restart(
    db: Db,
    url: &str,
    api: &FakeWorkloadApi,
    domain: &FakeTrustDomain,
    partner: &FakeTrustDomain,
    svid: &IssuedSvid,
    source_config: TransportConfig,
) -> Db {
    let document =
        br#"{"owner":"host-tls","actor":"operator","change_ref":"fresh-install","names":[]}"#;
    crate::transport::source_history::coordinator::initialize_host_history(
        url,
        document.to_vec(),
        true,
    )
    .await
    .unwrap();
    let runtime = TransportRuntime::build(source_config.clone(), &db, &NoManagedIdentity)
        .await
        .unwrap()
        .unwrap();
    let first = runtime.generations.checked_current(None).unwrap().number;
    assert!(runtime
        .generations
        .checked_current(None)
        .unwrap()
        .peer_trust
        .contains_key(&TrustProfileRef::new("partner.test").unwrap()));
    api.push_snapshot(snapshot(domain, svid, None));
    runtime
        .spiffe
        .as_ref()
        .unwrap()
        .wait_for(Duration::from_secs(5), |status| {
            status.phase == SourcePhase::Streaming && status.generation.is_some_and(|n| n > first)
        })
        .await
        .expect("partner removal");
    assert!(!runtime
        .generations
        .checked_current(None)
        .unwrap()
        .peer_trust
        .contains_key(&TrustProfileRef::new("partner.test").unwrap()));
    drop(runtime);
    // A dropped source may finish a previously started write asynchronously.
    // The next owner must wait for that work before loading its history.
    wait_for_history_owner().await;
    db.pool().close().await;
    drop(db);
    let db = opensesame_storage::Db::connect_sqlite(url).await.unwrap();

    // Reconstruct an active source manager, not just a PEM manager. A local
    // update cannot reclaim the removed name, but unrelated trust still works.
    let restored = TransportRuntime::build(source_config, &db, &NoManagedIdentity)
        .await
        .unwrap()
        .unwrap();
    let mut colliding = local_candidate(&restored.generations);
    colliding.peer_trust.insert(
        TrustProfileRef::new("partner.test").unwrap(),
        local_bundle("partner.test", partner),
    );
    assert_eq!(
        restored.generations.activate(colliding),
        Err(TransportError::GenerationStale)
    );
    let local = FakeTrustDomain::new("local.test");
    let mut unrelated = local_candidate(&restored.generations);
    unrelated.peer_trust.insert(
        TrustProfileRef::new("local.test").unwrap(),
        local_bundle("local.test", &local),
    );
    restored.generations.activate(unrelated).unwrap();
    assert!(restored
        .generations
        .checked_current(None)
        .unwrap()
        .peer_trust
        .contains_key(&TrustProfileRef::new("local.test").unwrap()));
    drop(restored);
    wait_for_history_owner().await;

    db
}

async fn exercise_local_sources(
    db: &Db,
    mut pem_config: TransportConfig,
    mut managed_config: TransportConfig,
    managed_resolver: &ManagedIdentity,
    bindings_only: TransportConfig,
) {
    let listener = pem_config.listener.as_mut().unwrap();
    listener.client_trust_profile = TrustProfileRef::new("partner.test").unwrap();
    assert!(
        TransportRuntime::build(pem_config.clone(), db, &NoManagedIdentity)
            .await
            .is_err(),
        "a PEM bundle cannot take a previously source-owned name"
    );
    pem_config.listener.as_mut().unwrap().client_trust_profile =
        TrustProfileRef::new("local.test").unwrap();
    let pem = TransportRuntime::build(pem_config, db, &NoManagedIdentity)
        .await
        .unwrap()
        .unwrap();
    let current = pem.generations.checked_current(None).unwrap();
    assert!(current
        .peer_trust
        .contains_key(&TrustProfileRef::new("local.test").unwrap()));
    assert!(!current
        .peer_trust
        .contains_key(&TrustProfileRef::new("partner.test").unwrap()));
    drop(current);
    drop(pem);

    managed_config
        .listener
        .as_mut()
        .unwrap()
        .client_trust_profile = TrustProfileRef::new("partner.test").unwrap();
    assert!(
        TransportRuntime::build(managed_config.clone(), db, managed_resolver)
            .await
            .is_err()
    );
    managed_config
        .listener
        .as_mut()
        .unwrap()
        .client_trust_profile = TrustProfileRef::new("local.test").unwrap();
    let managed = TransportRuntime::build(managed_config, db, managed_resolver)
        .await
        .unwrap()
        .unwrap();
    assert!(managed
        .generations
        .checked_current(None)
        .unwrap()
        .peer_trust
        .contains_key(&TrustProfileRef::new("local.test").unwrap()));
    drop(managed);

    let runtime = TransportRuntime::build(bindings_only, db, &NoManagedIdentity)
        .await
        .unwrap()
        .unwrap();
    let generation = runtime.generations.checked_current(None).unwrap().number;
    let source = runtime
        .generations
        .source_trust(generation)
        .unwrap()
        .unwrap();
    assert!(source
        .reserved
        .contains(&TrustProfileRef::new("partner.test").unwrap()));
    drop(runtime);
}
