//! PKCE S256 verifiers and OAuth `state` values (RFC 7636, ADR 0032 §4).
//!
//! Both are 32 bytes from the operating system's CSPRNG, base64url-encoded
//! without padding, generated directly rather than through an OAuth client
//! crate.

use rand::Rng;
use sha2::{Digest, Sha256};

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub const CHALLENGE_METHOD: &str = "S256";

impl Pkce {
    #[must_use]
    pub fn generate() -> Self {
        // RFC 7636 §4.1: 32 random octets, base64url-encoded, give a
        // 43-character verifier from the unreserved alphabet.
        let verifier = random_base64url::<32>();
        let challenge = Self::challenge_for(&verifier);
        Self {
            verifier,
            challenge,
        }
    }

    /// The challenge a verifier must produce, per RFC 7636 §4.2. This is also
    /// used to check verifiers we did not generate.
    #[must_use]
    pub fn challenge_for(verifier: &str) -> String {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
    }
}

/// 32 random bytes (256 bits), base64url-encoded; a guessable `state` is a
/// session-fixation hole.
#[must_use]
pub fn new_state() -> String {
    random_base64url::<32>()
}

/// `N` bytes from the operating system's CSPRNG, base64url-encoded without
/// padding.
fn random_base64url<const N: usize>() -> String {
    use base64::Engine;
    let mut bytes = [0u8; N];
    rand::rand_core::UnwrapErr(rand::rngs::SysRng).fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}
