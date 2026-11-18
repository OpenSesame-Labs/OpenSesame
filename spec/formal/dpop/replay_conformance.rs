#![allow(dead_code)]

extern crate self as chrono;

pub struct Utc;
pub struct Timestamp;
impl Utc {
    pub fn now() -> Timestamp {
        Timestamp
    }
}
impl Timestamp {
    pub fn timestamp(&self) -> i64 {
        panic!("the conformance harness supplies an explicit clock")
    }
}

#[derive(Debug)]
pub enum ProofError {
    InvalidProof(String),
    Replay(String),
}

mod jwk {
    pub const DPOP_MAX_FUTURE_SKEW_SECS: i64 = 60;
}

mod replay {
    include!(env!("DPOP_REPLAY_SOURCE"));
}

use replay::{InMemoryReplayCache, ReplayCache};
use std::collections::HashSet;
use std::sync::{Arc, Barrier};

fn classify(result: Result<(), ProofError>) -> &'static str {
    match result {
        Ok(()) => "accepted",
        Err(ProofError::Replay(_)) => "replay",
        Err(ProofError::InvalidProof(message)) if message.contains("capacity") => "capacity",
        Err(ProofError::InvalidProof(_)) => "invalid",
    }
}

fn identifier(kind: &str) -> String {
    match kind {
        "empty" => String::new(),
        "ascii1" => "a".into(),
        "ascii256" => "a".repeat(256),
        "ascii257" => "a".repeat(257),
        "utf8_128" => "é".repeat(128),
        "utf8_129" => "é".repeat(129),
        _ => panic!("unknown identifier case: {kind}"),
    }
}

fn check_vectors(path: &str) {
    let vectors = std::fs::read_to_string(path).expect("read Lean vectors");
    let mut count = 0;
    let mut inputs = HashSet::new();
    for line in vectors.lines() {
        let fields: Vec<_> = line.split('\t').collect();
        assert_eq!(fields.len(), 9, "invalid vector: {line}");
        let jti = identifier(fields[0]);
        let first: i64 = fields[1].parse().unwrap();
        let ttl: i64 = fields[2].parse().unwrap();
        let valid_offset: i64 = fields[3].parse().unwrap();
        let replay_offset: i64 = fields[4].parse().unwrap();
        let capacity: usize = fields[5].parse().unwrap();
        let prefill: bool = match fields[6] {
            "0" => false,
            "1" => true,
            _ => panic!("invalid prefill bit: {line}"),
        };
        assert!([0, 100, i64::MAX - 1, i64::MIN + 1].contains(&first));
        assert!([-1, 0, 1, 300].contains(&ttl));
        assert!([-1, 0, 1, 360].contains(&valid_offset));
        assert!([0, 1, 360, 361].contains(&replay_offset));
        assert!([0, 1, 2].contains(&capacity));
        assert!(
            inputs.insert(fields[..7].join("/")),
            "duplicate vector: {line}"
        );
        let valid_until = first.saturating_add(valid_offset);
        let second = first.saturating_add(replay_offset);
        let cache = InMemoryReplayCache::with_limits(ttl, capacity);
        if prefill {
            let _ = cache.check_and_record_until("other", first, valid_until);
        }
        let first_result = classify(cache.check_and_record_until(&jti, first, valid_until));
        let second_result = classify(cache.check_and_record_until(&jti, second, valid_until));
        assert_eq!(first_result, fields[7], "first decision mismatch: {line}");
        assert_eq!(second_result, fields[8], "second decision mismatch: {line}");
        count += 1;
    }
    assert_eq!(count, 9216, "incomplete Lean vector matrix");
    println!("DPoP replay correspondence: {count} cases passed");
}

fn check_concurrent_duplicate() {
    for _ in 0..40 {
        let cache = Arc::new(InMemoryReplayCache::with_limits(300, 16));
        let barrier = Arc::new(Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let cache = Arc::clone(&cache);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    classify(cache.check_and_record_until("shared", 100, 460))
                })
            })
            .collect();
        let outcomes: Vec<_> = workers
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(outcomes.iter().filter(|x| **x == "accepted").count(), 1);
        assert_eq!(outcomes.iter().filter(|x| **x == "replay").count(), 7);
    }
    println!("DPoP replay concurrency: 40 eight-thread races passed");
}

fn main() {
    let path = std::env::args().nth(1).expect("pass the Lean vector file");
    check_vectors(&path);
    check_concurrent_duplicate();
}
