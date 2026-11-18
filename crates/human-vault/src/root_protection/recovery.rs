//! Recovery-key protector wrap helpers.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::Rng;
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::{hkdf_expand, VaultRootKey};

use super::error::ProtectionError;
use super::limits::DOMAIN_RECOVERY_WRAP;
use super::types::RecoveryWrap;

/// Wrap `vrk` under a high-entropy recovery secret.
///
/// # Errors
///
/// Returns crypto failures when AEAD or KDF fails.
pub fn wrap_vrk_with_recovery_key(
    recovery_key: &[u8; 32],
    vrk: &VaultRootKey,
) -> Result<(RecoveryWrap, String), ProtectionError> {
    let mut kek = hkdf_expand(recovery_key, DOMAIN_RECOVERY_WRAP)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&kek).map_err(|_| ProtectionError::Crypto)?;
    kek.zeroize();
    let mut nonce = [0u8; 24];
    rand::rng().fill_bytes(&mut nonce);
    let nonce_ref: &XNonce = (&nonce).into();
    let ct = cipher
        .encrypt(nonce_ref, vrk.0.as_ref())
        .map_err(|_| ProtectionError::Crypto)?;
    let fingerprint = fingerprint_recovery_key(recovery_key);
    Ok((
        RecoveryWrap {
            nonce_b64: URL_SAFE_NO_PAD.encode(nonce),
            ct_b64: URL_SAFE_NO_PAD.encode(ct),
        },
        fingerprint,
    ))
}

/// Unwrap a recovery wrap.
///
/// # Errors
///
/// Returns `CapsuleAuthFailed` when the recovery key does not open the wrap.
pub fn unwrap_vrk_with_recovery_key(
    recovery_key: &[u8; 32],
    wrap: &RecoveryWrap,
) -> Result<VaultRootKey, ProtectionError> {
    let mut kek = hkdf_expand(recovery_key, DOMAIN_RECOVERY_WRAP)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&kek).map_err(|_| ProtectionError::Crypto)?;
    kek.zeroize();
    let nonce = URL_SAFE_NO_PAD
        .decode(&wrap.nonce_b64)
        .map_err(|_| ProtectionError::MalformedEncoding("recovery nonce".into()))?;
    let nonce_ref = <&XNonce>::try_from(nonce.as_slice())
        .map_err(|_| ProtectionError::MalformedEncoding("recovery nonce length".into()))?;
    let ct = URL_SAFE_NO_PAD
        .decode(&wrap.ct_b64)
        .map_err(|_| ProtectionError::MalformedEncoding("recovery ciphertext".into()))?;
    let mut pt = cipher
        .decrypt(nonce_ref, ct.as_ref())
        .map_err(|_| ProtectionError::CapsuleAuthFailed)?;
    if pt.len() != 32 {
        pt.zeroize();
        return Err(ProtectionError::InvalidKeyLength);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&pt);
    pt.zeroize();
    Ok(VaultRootKey(out))
}

#[must_use]
pub fn fingerprint_recovery_key(recovery_key: &[u8; 32]) -> String {
    let digest = Sha256::digest(recovery_key);
    URL_SAFE_NO_PAD.encode(&digest[..16])
}

/// Generate a fresh 32-byte recovery secret.
#[must_use]
pub fn generate_recovery_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    rand::rng().fill_bytes(&mut key);
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_nonce_and_ciphertext_lengths_fail_closed() {
        let recovery_key = [7u8; 32];
        let vrk = VaultRootKey([9u8; 32]);
        let (valid, _) = wrap_vrk_with_recovery_key(&recovery_key, &vrk).unwrap();

        for len in [0usize, 23, 25, 64] {
            let mut malformed = valid.clone();
            malformed.nonce_b64 = URL_SAFE_NO_PAD.encode(vec![0u8; len]);
            assert!(matches!(
                unwrap_vrk_with_recovery_key(&recovery_key, &malformed),
                Err(ProtectionError::MalformedEncoding(_))
            ));
        }

        for len in [0usize, 15, 16, 47] {
            let mut malformed = valid.clone();
            malformed.ct_b64 = URL_SAFE_NO_PAD.encode(vec![0u8; len]);
            assert!(matches!(
                unwrap_vrk_with_recovery_key(&recovery_key, &malformed),
                Err(ProtectionError::CapsuleAuthFailed)
            ));
        }

        assert_eq!(
            unwrap_vrk_with_recovery_key(&recovery_key, &valid)
                .unwrap()
                .0,
            vrk.0
        );
    }
}
