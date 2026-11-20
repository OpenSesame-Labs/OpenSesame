//! Stored-profile adoption with durable source-name reservations.

use std::collections::BTreeSet;

use super::*;
use opensesame_transport_security::SourceOwner;

fn source_manager(
    state: &AppState,
) -> (
    Arc<TransportGenerations>,
    SourceOwner,
    u64,
    GenerationCandidate,
) {
    source_manager_with_history(state, true)
}

fn source_manager_with_history(
    state: &AppState,
    reserve_old: bool,
) -> (
    Arc<TransportGenerations>,
    SourceOwner,
    u64,
    GenerationCandidate,
) {
    let generations = attached(state, &DisposableCa::new("clients"));
    if reserve_old {
        let reserved = BTreeSet::from([support::profile_ref("old-source.test")]);
        generations.seed_source_history(1, &reserved).unwrap();
    }
    let current = generations.current();
    let source = GenerationCandidate {
        identity: current.identity.clone(),
        peer_trust: current.peer_trust.clone(),
        own_trust: None,
        identity_required: true,
    };
    let owner = generations.source_owner();
    let claimed = generations.claim_source(&owner).unwrap();
    let epoch = generations
        .activate_from_source(&owner, claimed, source.clone())
        .unwrap();
    (generations, owner, epoch, source)
}

#[tokio::test]
#[ignore = "requires vectors emitted by the checked Lean model"]
async fn lean_vectors_match_stored_trust_adoption_and_rotation() {
    let path = std::env::var("OPENSESAME_SOURCE_HISTORY_VECTORS").unwrap();
    let vectors = std::fs::read_to_string(path).unwrap();
    let bit = |value: &str| match value {
        "0" => false,
        "1" => true,
        _ => panic!("invalid model bit"),
    };
    let mut seen = BTreeSet::new();
    for line in vectors
        .lines()
        .filter(|line| line.starts_with("lifecycle\t"))
    {
        let fields: Vec<_> = line.split('\t').collect();
        assert_eq!(fields.len(), 6);
        let reserved = bit(fields[1]);
        let rotated = bit(fields[2]);
        assert!(seen.insert((reserved, rotated)));
        let state = support::state().await;
        let (generations, owner, epoch, source) = source_manager_with_history(&state, reserved);
        let old = profile("old-source.test", &DisposableCa::new("old"));
        let unrelated = profile("local.test", &DisposableCa::new("local"));
        store(
            &state,
            &TrustProfileSet {
                revision: 1,
                profiles: vec![old.clone(), unrelated.clone()],
            },
        )
        .await;
        assert!(trust::refresh(&state, opensesame_time::Utc::now()).await.unwrap());
        if rotated {
            generations
                .activate_from_source(&owner, epoch, source)
                .unwrap();
        }
        let refreshed = trust::refresh(&state, opensesame_time::Utc::now()).await.unwrap();
        let current = generations.checked_current(None).unwrap();
        assert_eq!(
            current.peer_trust.contains_key(&old.profile),
            bit(fields[3]),
            "{line}"
        );
        assert_eq!(
            current.peer_trust.contains_key(&unrelated.profile),
            bit(fields[4]),
            "{line}"
        );
        assert_eq!(refreshed, bit(fields[5]), "{line}");
    }
    assert_eq!(seen.len(), 4, "model must emit all lifecycle cases");
}

async fn store(state: &AppState, set: &TrustProfileSet) {
    state
        .db
        .set_host_kv(
            trust::KV_TRUST_PROFILES,
            &serde_json::to_string(set).unwrap(),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn colliding_stored_name_is_quarantined_without_hiding_unrelated_trust() {
    let state = support::state().await;
    let (generations, _, _, _) = source_manager(&state);
    let old = profile("old-source.test", &DisposableCa::new("old"));
    let unrelated = profile("local.test", &DisposableCa::new("local"));
    let stored = TrustProfileSet {
        revision: 1,
        profiles: vec![old.clone(), unrelated.clone()],
    };
    store(&state, &stored).await;
    assert!(trust::refresh(&state, opensesame_time::Utc::now()).await.unwrap());
    let current = generations.checked_current(None).unwrap();
    assert!(!current.peer_trust.contains_key(&old.profile));
    assert!(current.peer_trust.contains_key(&unrelated.profile));
    let epoch = state
        .transport_lifecycle
        .with_trust_epoch(|epoch| epoch.clone());
    assert_eq!(epoch.quarantined, BTreeSet::from([old.profile.clone()]));
    assert_eq!(epoch.generation, Some(current.number));

    assert!(trust::put_cas(&state, stored.clone(), "operator", false)
        .await
        .is_err());
    assert_eq!(trust::load(&state).await.unwrap(), stored);
    let cleaned = trust::put_cas(
        &state,
        TrustProfileSet {
            revision: 1,
            profiles: vec![unrelated.clone()],
        },
        "operator",
        false,
    )
    .await
    .unwrap();
    assert_eq!(cleaned.revision, 2);
    assert!(generations
        .current()
        .peer_trust
        .contains_key(&unrelated.profile));
    assert!(!generations.current().peer_trust.contains_key(&old.profile));
    assert!(state
        .transport_lifecycle
        .with_trust_epoch(|epoch| epoch.quarantined.is_empty()));
}

#[tokio::test]
async fn source_rotation_reconciles_unrelated_trust_without_a_stored_revision_change() {
    let state = support::state().await;
    let (generations, owner, epoch, source) = source_manager(&state);
    let unrelated = profile("local.test", &DisposableCa::new("local"));
    store(
        &state,
        &TrustProfileSet {
            revision: 1,
            profiles: vec![unrelated.clone()],
        },
    )
    .await;
    assert!(trust::refresh(&state, opensesame_time::Utc::now()).await.unwrap());
    let adopted = generations.current().number;
    assert!(generations
        .current()
        .peer_trust
        .contains_key(&unrelated.profile));
    generations
        .activate_from_source(&owner, epoch, source)
        .unwrap();
    assert!(!generations
        .current()
        .peer_trust
        .contains_key(&unrelated.profile));
    assert!(trust::refresh(&state, opensesame_time::Utc::now()).await.unwrap());
    let current = generations.checked_current(None).unwrap();
    assert!(current.number > adopted);
    assert!(current.peer_trust.contains_key(&unrelated.profile));
    let epoch = state
        .transport_lifecycle
        .with_trust_epoch(|epoch| epoch.clone());
    assert_eq!(epoch.revision, 1);
    assert_eq!(epoch.generation, Some(current.number));
}

#[tokio::test]
async fn generation_notification_reconciles_without_waiting_for_the_periodic_tick() {
    let state = support::state().await;
    let (generations, owner, epoch, source) = source_manager(&state);
    let unrelated = profile("local.test", &DisposableCa::new("local"));
    store(
        &state,
        &TrustProfileSet {
            revision: 1,
            profiles: vec![unrelated.clone()],
        },
    )
    .await;
    assert!(trust::refresh(&state, opensesame_time::Utc::now()).await.unwrap());
    let changes = generations.subscribe();
    let interval = std::time::Duration::from_mins(1);
    let ticks = tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
    let watcher = tokio::spawn(crate::transport_lifecycle::boot::run_refresh_with_changes(
        state.clone(),
        Some(changes),
        ticks,
    ));
    generations
        .activate_from_source(&owner, epoch, source)
        .unwrap();
    let mut observed = generations.subscribe();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !generations
            .checked_current(None)
            .is_ok_and(|current| current.peer_trust.contains_key(&unrelated.profile))
        {
            observed.changed().await.unwrap();
        }
    })
    .await
    .expect("generation notification did not reconcile stored trust");
    watcher.abort();
    let _ = watcher.await;
    assert_eq!(trust::load(&state).await.unwrap().revision, 1);
}

#[tokio::test]
async fn rotation_after_swap_before_epoch_record_keeps_the_exact_installed_generation() {
    let state = support::state().await;
    let (generations, owner, epoch, source) = source_manager(&state);
    let unrelated = profile("local.test", &DisposableCa::new("local"));
    let stored = TrustProfileSet {
        revision: 1,
        profiles: vec![unrelated.clone()],
    };
    store(&state, &stored).await;
    let (swapped_tx, swapped_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let worker_state = state.clone();
    let worker_set = stored.clone();
    let worker = tokio::spawn(async move {
        let _serial = crate::transport_lifecycle::trust_activate::TRUST_SERIAL
            .lock()
            .await;
        crate::transport_lifecycle::trust_store::adopt_with_after_activation(
            &worker_state,
            &worker_set,
            opensesame_time::Utc::now(),
            async move {
                swapped_tx.send(()).unwrap();
                release_rx.await.unwrap();
            },
        )
        .await
    });
    swapped_rx.await.unwrap();
    let installed = generations.current().number;
    assert!(generations
        .current()
        .peer_trust
        .contains_key(&unrelated.profile));
    let rotated = generations
        .activate_from_source(&owner, epoch, source)
        .unwrap();
    assert!(rotated > installed);
    assert!(!generations
        .current()
        .peer_trust
        .contains_key(&unrelated.profile));
    release_tx.send(()).unwrap();
    assert!(worker.await.unwrap().unwrap());
    assert_eq!(
        state
            .transport_lifecycle
            .with_trust_epoch(|epoch| epoch.generation),
        Some(installed)
    );
    assert!(trust::refresh(&state, opensesame_time::Utc::now()).await.unwrap());
    let current = generations.checked_current(None).unwrap();
    assert!(current.peer_trust.contains_key(&unrelated.profile));
    assert_eq!(
        state
            .transport_lifecycle
            .with_trust_epoch(|epoch| epoch.generation),
        Some(current.number)
    );
}
