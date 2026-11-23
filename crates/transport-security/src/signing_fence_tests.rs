use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use opensesame_time::Utc;
use rustls::server::StoresServerSessions;
use rustls::sign::{CertifiedKey, Signer, SigningKey};
use rustls::{Error, SignatureAlgorithm, SignatureScheme};

use super::{fence_key, fence_sessions};
use crate::generations::{GenerationCandidate, SourceOwner, TransportGenerations};
use crate::testkit::DisposableCa;

const SCHEME: SignatureScheme = SignatureScheme::ECDSA_NISTP256_SHA256;

#[derive(Debug)]
struct ControlledKey {
    entered: mpsc::Sender<()>,
    resume: Arc<Mutex<mpsc::Receiver<()>>>,
    calls: Arc<AtomicUsize>,
}

impl SigningKey for ControlledKey {
    fn choose_scheme(&self, offered: &[SignatureScheme]) -> Option<Box<dyn Signer>> {
        offered.contains(&SCHEME).then(|| {
            Box::new(ControlledSigner {
                entered: self.entered.clone(),
                resume: Arc::clone(&self.resume),
                calls: Arc::clone(&self.calls),
            }) as Box<dyn Signer>
        })
    }

    fn algorithm(&self) -> SignatureAlgorithm {
        SignatureAlgorithm::ECDSA
    }
}

#[derive(Debug)]
struct ControlledSigner {
    entered: mpsc::Sender<()>,
    resume: Arc<Mutex<mpsc::Receiver<()>>>,
    calls: Arc<AtomicUsize>,
}

impl Signer for ControlledSigner {
    fn sign(&self, _message: &[u8]) -> Result<Vec<u8>, Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.send(()).unwrap();
        self.resume.lock().unwrap().recv().unwrap();
        Ok(vec![1, 2, 3])
    }

    fn scheme(&self) -> SignatureScheme {
        SCHEME
    }
}

fn source() -> (
    Arc<TransportGenerations>,
    SourceOwner,
    u64,
    GenerationCandidate,
) {
    let ca = DisposableCa::new("signing-fence");
    let candidate = GenerationCandidate {
        identity: Some(Arc::new(ca.issue_server("localhost").identity())),
        identity_required: true,
        ..GenerationCandidate::default()
    };
    let initial = candidate.clone().into_generation(1, Utc::now()).unwrap();
    let generations = TransportGenerations::new(initial);
    let owner = generations.source_owner();
    let reserved = generations.claim_source(&owner).unwrap();
    let epoch = generations
        .activate_from_source(&owner, reserved, candidate.clone())
        .unwrap();
    (generations, owner, epoch, candidate)
}

fn controlled_key(
    generations: &Arc<TransportGenerations>,
    epoch: u64,
) -> (
    CertifiedKey,
    mpsc::Receiver<()>,
    mpsc::Sender<()>,
    Arc<AtomicUsize>,
) {
    let (entered_tx, entered_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let calls = Arc::new(AtomicUsize::new(0));
    let key = Arc::new(ControlledKey {
        entered: entered_tx,
        resume: Arc::new(Mutex::new(resume_rx)),
        calls: Arc::clone(&calls),
    });
    (
        fence_key(CertifiedKey::new(Vec::new(), key), generations, epoch),
        entered_rx,
        resume_tx,
        calls,
    )
}

#[test]
fn expiry_before_signing_never_calls_the_private_key() {
    let (generations, owner, epoch, _) = source();
    let (key, _entered, _resume, calls) = controlled_key(&generations, epoch);
    let signer = key.key.choose_scheme(&[SCHEME]).unwrap();
    generations
        .tighten_source_deadline(
            &owner,
            epoch,
            Utc::now() - opensesame_time::Duration::seconds(1),
        )
        .unwrap();
    assert!(signer.sign(b"handshake").is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(key.key.choose_scheme(&[SCHEME]).is_none());
}

#[test]
fn a_delayed_signature_is_withheld_if_expiry_or_rotation_occurs() {
    for rotate in [false, true] {
        let (generations, owner, epoch, candidate) = source();
        let (key, entered, resume, calls) = controlled_key(&generations, epoch);
        let signer = key.key.choose_scheme(&[SCHEME]).unwrap();
        let signing = std::thread::spawn(move || signer.sign(b"handshake"));
        entered
            .recv_timeout(Duration::from_secs(5))
            .expect("the underlying signer was entered");
        if rotate {
            generations
                .activate_from_source(&owner, epoch, candidate)
                .unwrap();
        } else {
            generations
                .tighten_source_deadline(
                    &owner,
                    epoch,
                    Utc::now() - opensesame_time::Duration::seconds(1),
                )
                .unwrap();
        }
        resume.send(()).unwrap();
        assert!(signing.join().unwrap().is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn a_live_signature_is_returned_and_a_dropped_manager_fails_closed() {
    let (generations, _owner, epoch, _) = source();
    let (key, entered, resume, calls) = controlled_key(&generations, epoch);
    let signer = key.key.choose_scheme(&[SCHEME]).unwrap();
    let signing = std::thread::spawn(move || signer.sign(b"handshake"));
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    resume.send(()).unwrap();
    assert_eq!(signing.join().unwrap().unwrap(), [1, 2, 3]);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    drop(generations);
    assert!(key.key.choose_scheme(&[SCHEME]).is_none());
}

#[test]
fn a_preclaim_session_cache_cannot_return_secrets_after_claim() {
    let initial = GenerationCandidate::default()
        .into_generation(1, Utc::now())
        .unwrap();
    let generations = TransportGenerations::new(initial);
    let inner: Arc<dyn StoresServerSessions> = rustls::server::ServerSessionMemoryCache::new(8);
    let cache = fence_sessions(Arc::clone(&inner), &generations, 1);
    assert!(cache.put(b"ticket".to_vec(), b"secret".to_vec()));
    assert_eq!(cache.get(b"ticket"), Some(b"secret".to_vec()));
    let owner = generations.source_owner();
    generations.claim_source(&owner).unwrap();
    assert_eq!(inner.get(b"ticket"), Some(b"secret".to_vec()));
    assert_eq!(cache.get(b"ticket"), None);
    assert_eq!(cache.take(b"ticket"), None);
    assert!(!cache.can_cache());
    assert!(!cache.put(b"new".to_vec(), b"secret".to_vec()));
}

#[derive(Debug)]
struct DelayedSessionStore {
    entered: mpsc::Sender<()>,
    resume: Mutex<mpsc::Receiver<()>>,
}

impl StoresServerSessions for DelayedSessionStore {
    fn put(&self, _key: Vec<u8>, _value: Vec<u8>) -> bool {
        true
    }

    fn get(&self, _key: &[u8]) -> Option<Vec<u8>> {
        self.entered.send(()).unwrap();
        self.resume.lock().unwrap().recv().unwrap();
        Some(b"secret".to_vec())
    }

    fn take(&self, key: &[u8]) -> Option<Vec<u8>> {
        self.get(key)
    }

    fn can_cache(&self) -> bool {
        true
    }
}

#[test]
fn delayed_session_retrieval_withholds_secrets_after_source_claim() {
    for take in [false, true] {
        let initial = GenerationCandidate::default()
            .into_generation(1, Utc::now())
            .unwrap();
        let generations = TransportGenerations::new(initial);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let inner = Arc::new(DelayedSessionStore {
            entered: entered_tx,
            resume: Mutex::new(resume_rx),
        });
        let cache = fence_sessions(inner, &generations, 1);
        let retrieval = std::thread::spawn(move || {
            if take {
                cache.take(b"ticket")
            } else {
                cache.get(b"ticket")
            }
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let owner = generations.source_owner();
        generations.claim_source(&owner).unwrap();
        resume_tx.send(()).unwrap();
        assert_eq!(retrieval.join().unwrap(), None);
    }
}

#[test]
#[ignore = "requires Lean vectors; run spec/formal/source-lifetime/verify.sh"]
fn lean_vectors_match_generation_bound_signer() {
    let path = std::env::var("OPENSESAME_SOURCE_LIFETIME_VECTORS")
        .expect("run the source-lifetime formal verification script");
    let input = std::fs::read_to_string(path).expect("read Lean source-lifetime vectors");
    let mut seen = HashSet::new();
    for line in input.lines().filter(|line| line.starts_with("sign\t")) {
        let fields: Vec<_> = line.split('\t').collect();
        let ["sign", initially_usable, transition, released] = fields.as_slice() else {
            panic!("invalid signer vector: {line}");
        };
        let parse_bit = |value| match value {
            "0" => false,
            "1" => true,
            _ => panic!("invalid signer vector bit: {value}"),
        };
        let initially_usable = parse_bit(initially_usable);
        let expected = parse_bit(released);
        let transition_number: u8 = transition.parse().expect("numeric signer transition");
        assert_eq!(
            transition_number.to_string(),
            *transition,
            "noncanonical signer transition"
        );
        let transition = transition_number;
        assert!(transition <= 3, "unknown signer transition");
        assert!(
            seen.insert((initially_usable, transition)),
            "duplicate signer input"
        );
        let (generations, owner, epoch, candidate) = source();
        let (key, entered, resume, calls) = controlled_key(&generations, epoch);
        let signer = key.key.choose_scheme(&[SCHEME]).unwrap();
        let result = if initially_usable {
            let signing = std::thread::spawn(move || signer.sign(b"handshake"));
            entered.recv_timeout(Duration::from_secs(5)).unwrap();
            match transition {
                0 => {}
                1 => generations
                    .tighten_source_deadline(
                        &owner,
                        epoch,
                        Utc::now() - opensesame_time::Duration::seconds(1),
                    )
                    .unwrap(),
                2 => generations
                    .withdraw_from_source(
                        &owner,
                        epoch,
                        opensesame_domain::TransportError::IdentityMissing,
                    )
                    .unwrap(),
                3 => {
                    generations
                        .activate_from_source(&owner, epoch, candidate)
                        .unwrap();
                }
                _ => unreachable!(),
            }
            resume.send(()).unwrap();
            let result = signing.join().unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 1, "{line}");
            result
        } else {
            generations
                .tighten_source_deadline(
                    &owner,
                    epoch,
                    Utc::now() - opensesame_time::Duration::seconds(1),
                )
                .unwrap();
            // If the pre-check regresses, the underlying test signer may run;
            // pre-release it so that the assertion fails rather than hangs.
            resume.send(()).unwrap();
            let result = signer.sign(b"handshake");
            assert_eq!(calls.load(Ordering::SeqCst), 0, "{line}");
            result
        };
        assert_eq!(result.is_ok(), expected, "{line}");
    }
    assert_eq!(seen.len(), 8, "incomplete Lean signer vector matrix");
}
