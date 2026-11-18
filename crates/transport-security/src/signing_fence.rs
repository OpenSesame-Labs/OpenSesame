//! Fence signing and stateful session retrieval for a generation-bound TLS listener.
//!
//! A result is withheld from rustls if the check after the inner signer sees
//! expiry, withdrawal, or rotation. Scheduling between the checks can still
//! let the underlying key operate after a deadline, and an in-flight signer
//! cannot be cancelled. The generation can also change after the final check,
//! before rustls returns or transmits bytes. This is not a hard real-time
//! guarantee on key use or network output.
//! A session retrieved before a source claim can similarly race the claim;
//! the listener rejects a stale generation before application admission.
//! Standalone outbound `client_config` does not bind a generation and is not
//! covered by this guard.

use std::fmt;
use std::sync::{Arc, Weak};

use rustls::pki_types::SubjectPublicKeyInfoDer;
use rustls::server::StoresServerSessions;
use rustls::sign::{CertifiedKey, Signer, SigningKey};
use rustls::{Error, SignatureAlgorithm, SignatureScheme};

use crate::generations::TransportGenerations;

#[derive(Clone)]
struct SigningFence {
    generations: Weak<TransportGenerations>,
    expected: u64,
}

impl SigningFence {
    fn is_current(&self) -> bool {
        self.generations
            .upgrade()
            .is_some_and(|generations| generations.checked_current(Some(self.expected)).is_ok())
    }

    fn check(&self) -> Result<(), Error> {
        if self.is_current() {
            Ok(())
        } else {
            Err(Error::General(
                "transport signing generation unavailable".into(),
            ))
        }
    }
}

struct FencedKey {
    inner: Arc<dyn SigningKey>,
    fence: SigningFence,
}

impl fmt::Debug for FencedKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FencedKey")
            .field("generation", &self.fence.expected)
            .finish_non_exhaustive()
    }
}

impl SigningKey for FencedKey {
    fn choose_scheme(&self, offered: &[SignatureScheme]) -> Option<Box<dyn Signer>> {
        if !self.fence.is_current() {
            return None;
        }
        let signer = self.inner.choose_scheme(offered)?;
        Some(Box::new(FencedSigner {
            inner: signer,
            fence: self.fence.clone(),
        }))
    }

    fn public_key(&self) -> Option<SubjectPublicKeyInfoDer<'_>> {
        self.inner.public_key()
    }

    fn algorithm(&self) -> SignatureAlgorithm {
        self.inner.algorithm()
    }
}

struct FencedSigner {
    inner: Box<dyn Signer>,
    fence: SigningFence,
}

impl fmt::Debug for FencedSigner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FencedSigner")
            .field("generation", &self.fence.expected)
            .finish_non_exhaustive()
    }
}

impl Signer for FencedSigner {
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, Error> {
        self.fence.check()?;
        let signature = self.inner.sign(message)?;
        self.fence.check()?;
        Ok(signature)
    }

    fn scheme(&self) -> SignatureScheme {
        self.inner.scheme()
    }
}

pub(crate) fn fence_key(
    mut key: CertifiedKey,
    generations: &Arc<TransportGenerations>,
    expected: u64,
) -> CertifiedKey {
    key.key = Arc::new(FencedKey {
        inner: Arc::clone(&key.key),
        fence: SigningFence {
            generations: Arc::downgrade(generations),
            expected,
        },
    });
    key
}

struct FencedSessions {
    inner: Arc<dyn StoresServerSessions>,
    fence: SigningFence,
}

impl fmt::Debug for FencedSessions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FencedSessions")
            .field("generation", &self.fence.expected)
            .finish_non_exhaustive()
    }
}

impl StoresServerSessions for FencedSessions {
    fn put(&self, key: Vec<u8>, value: Vec<u8>) -> bool {
        self.fence.is_current() && self.inner.put(key, value) && self.fence.is_current()
    }

    fn get(&self, key: &[u8]) -> Option<Vec<u8>> {
        if !self.fence.is_current() {
            return None;
        }
        let value = self.inner.get(key)?;
        self.fence.is_current().then_some(value)
    }

    fn take(&self, key: &[u8]) -> Option<Vec<u8>> {
        if !self.fence.is_current() {
            return None;
        }
        let value = self.inner.take(key)?;
        self.fence.is_current().then_some(value)
    }

    fn can_cache(&self) -> bool {
        self.fence.is_current() && self.inner.can_cache()
    }
}

pub(crate) fn fence_sessions(
    inner: Arc<dyn StoresServerSessions>,
    generations: &Arc<TransportGenerations>,
    expected: u64,
) -> Arc<dyn StoresServerSessions> {
    Arc::new(FencedSessions {
        inner,
        fence: SigningFence {
            generations: Arc::downgrade(generations),
            expected,
        },
    })
}

#[cfg(all(test, feature = "testkit"))]
#[path = "signing_fence_tests.rs"]
mod tests;
