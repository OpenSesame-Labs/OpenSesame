use std::sync::mpsc;
use std::time::Duration;

use super::*;

#[test]
fn use_time_is_sampled_after_waiting_for_the_activation_lock() {
    let initial = GenerationCandidate::default()
        .into_generation(1, Utc::now())
        .unwrap();
    let generations = TransportGenerations::new(initial);
    let owner = generations.source_owner();
    let mut serial = generations.activation.lock().unwrap();
    serial.managed = true;
    serial.fence = Some(Fence {
        owner,
        epoch: 1,
        deadline: Some(Utc::now() + opensesame_time::Duration::minutes(1)),
        monotonic_deadline: Some(Instant::now() + Duration::from_mins(1)),
        expired: false,
        trust: BTreeMap::new(),
        own_trust: None,
    });
    let other = Arc::clone(&generations);
    let (clock_tx, clock_rx) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        other.checked_current_with_clock(None, || {
            clock_tx.send(()).unwrap();
            (Utc::now(), Instant::now())
        })
    });
    assert!(clock_rx.recv_timeout(Duration::from_millis(50)).is_err());
    serial.fence.as_mut().unwrap().deadline =
        Some(Utc::now() - opensesame_time::Duration::seconds(1));
    drop(serial);
    clock_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(matches!(
        thread.join().unwrap(),
        Err(TransportError::EvidenceExpired)
    ));
}

#[test]
fn monotonic_deadline_refuses_a_rollback_before_first_observation() {
    let now = Utc::now();
    let mono = Instant::now();
    let initial = GenerationCandidate::default()
        .into_generation(1, now)
        .unwrap();
    let generations = TransportGenerations::new(initial);
    let owner = generations.source_owner();
    let mut serial = generations.activation.lock().unwrap();
    serial.managed = true;
    serial.fence = Some(Fence {
        owner,
        epoch: 1,
        deadline: Some(now + opensesame_time::Duration::minutes(1)),
        monotonic_deadline: Some(mono + Duration::from_mins(1)),
        expired: false,
        trust: BTreeMap::new(),
        own_trust: None,
    });
    drop(serial);
    assert!(matches!(
        generations.checked_current_with_clock(None, || (
            now - opensesame_time::Duration::hours(1),
            mono + Duration::from_mins(1)
        )),
        Err(TransportError::EvidenceExpired)
    ));
}

#[test]
fn monotonic_outage_bound_survives_rollback_before_tightening() {
    let wall_at_observation = Utc::now();
    let monotonic_at_observation = Instant::now();
    let initial = GenerationCandidate::default()
        .into_generation(1, wall_at_observation)
        .unwrap();
    let generations = TransportGenerations::new(initial);
    let owner = generations.source_owner();
    let mut serial = generations.activation.lock().unwrap();
    serial.managed = true;
    serial.fence = Some(Fence {
        owner: owner.clone(),
        epoch: 1,
        deadline: Some(wall_at_observation + opensesame_time::Duration::hours(2)),
        monotonic_deadline: Some(monotonic_at_observation + Duration::from_hours(2)),
        expired: false,
        trust: BTreeMap::new(),
        own_trust: None,
    });
    drop(serial);
    // The independent bound was captured at outage detection; a rollback
    // before this call cannot reset the elapsed allowance.
    generations
        .tighten_source_deadline_bounded(
            &owner,
            1,
            wall_at_observation + opensesame_time::Duration::seconds(30),
            monotonic_at_observation + Duration::from_secs(30),
        )
        .unwrap();
    assert!(matches!(
        generations.checked_current_with_clock(None, || (
            wall_at_observation - opensesame_time::Duration::hours(1),
            monotonic_at_observation + Duration::from_secs(30)
        )),
        Err(TransportError::EvidenceExpired)
    ));
}
