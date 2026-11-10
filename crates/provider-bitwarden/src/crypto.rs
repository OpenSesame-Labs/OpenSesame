//! Bitwarden vault cryptography.
//!
//! ```text
//! master password + email (as salt)
//!   ├─ KDF: PBKDF2-SHA256 (default 600_000) OR Argon2id (m/t/p from prelogin)
//!   └─→ Master Key (256-bit)
//!         ├─ PBKDF2-SHA256(payload = MasterKey, salt = masterPassword, 1 iter)
//!         │    → Master Password Hash (base64, sent to the server)
//!         └─ HKDF-SHA256-Expand(MasterKey, info = "enc" | "mac")
//!              → 512-bit Stretched Master Key (32B enc || 32B mac)
//!                └─ AES-256-CBC + HMAC-SHA256 unwraps the 512-bit User Key
//!                     └─ decrypts every vault field (`EncString`)
//! ```
//!
//! Design rules enforced here:
//! * every key lives in a [`secrecy::SecretBox`], is zeroized on drop, and has
//!   no `Debug`/`Serialize` implementation that can print or persist it;
//! * MAC verification is constant time (`hmac`'s `verify_slice`) — never `==`;
//! * `EncString` type 7 (COSE) is refused by name, never best-effort decoded.
//!
//! Derived from the public Bitwarden format description; informed by rbw
//! (MIT, <https://github.com/doy/rbw>) — see `NOTICE`. No AGPL/GPL source.

use std::fmt;
use std::str::FromStr;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockModeDecrypt, BlockModeEncrypt, KeyIvInit};
use hmac::{Hmac, Mac};
use secrecy::{ExposeSecret, SecretBox};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
pub use crate::kdf::{
    Kdf, DEFAULT_PBKDF2_ITERATIONS, MAX_ARGON2_ITERATIONS, MAX_ARGON2_MEMORY_MIB,
    MAX_ARGON2_PARALLELISM, MAX_PBKDF2_ITERATIONS, MIN_ARGON2_ITERATIONS, MIN_ARGON2_MEMORY_MIB,
    MIN_PBKDF2_ITERATIONS,
};

type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
type HmacSha256 = Hmac<Sha256>;

const AES_BLOCK: usize = 16;
const KEY_LEN: usize = 32;
const MAC_LEN: usize = 32;

/// Bitwarden lowercases and trims the email before using it as KDF salt.
/// Getting this wrong derives a key that simply never opens the vault.
#[must_use]
pub fn normalize_email(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

/// The 256-bit master key. Never `Debug`, never serialized, never on disk.
pub struct MasterKey(SecretBox<[u8; KEY_LEN]>);

impl MasterKey {
    /// master password + email → 256-bit master key.
    ///
    /// # Errors
    ///
    /// Returns [`Error::InvalidKdfParameters`] or [`Error::KeyDerivation`]
    /// when the selected KDF parameters cannot be applied.
    pub fn derive(master_password: &[u8], email: &str, kdf: &Kdf) -> Result<Self> {
        let salt = normalize_email(email);
        let mut out = Zeroizing::new([0u8; KEY_LEN]);
        match *kdf {
            Kdf::Pbkdf2 { iterations } => {
                if iterations == 0 {
                    return Err(Error::InvalidKdfParameters(
                        "PBKDF2 iterations must be non-zero".into(),
                    ));
                }
                pbkdf2::pbkdf2_hmac::<Sha256>(
                    master_password,
                    salt.as_bytes(),
                    iterations,
                    out.as_mut(),
                );
            }
            Kdf::Argon2id {
                iterations,
                memory_kib,
                parallelism,
            } => {
                // Bitwarden salts Argon2id with SHA-256(email), not the email.
                let salt = Sha256::digest(salt.as_bytes());
                let params =
                    argon2::Params::new(memory_kib, iterations, parallelism, Some(KEY_LEN))
                        .map_err(|e| Error::InvalidKdfParameters(e.to_string()))?;
                argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
                    .hash_password_into(master_password, salt.as_slice(), out.as_mut())
                    .map_err(|e| Error::KeyDerivation(e.to_string()))?;
            }
        }
        Ok(Self(SecretBox::new(Box::new(*out))))
    }

    /// The hash the server sees: PBKDF2-SHA256 over the master **key**, salted
    /// with the master **password**, one iteration, base64. The server never
    /// sees anything that can decrypt the vault.
    #[must_use]
    pub fn password_hash_b64(&self, master_password: &[u8]) -> String {
        let mut out = Zeroizing::new([0u8; KEY_LEN]);
        pbkdf2::pbkdf2_hmac::<Sha256>(
            self.0.expose_secret().as_slice(),
            master_password,
            1,
            out.as_mut(),
        );
        B64.encode(out.as_ref())
    }

    /// HKDF-Expand the master key into the 512-bit stretched master key that
    /// unwraps the user key. The master key is already uniformly random, so
    /// Bitwarden expands without an extract step.
    ///
    /// # Panics
    ///
    /// Panics only if the fixed 32-byte HKDF input or output lengths violate
    /// the `HKDF-SHA256` implementation's documented limits.
    #[must_use]
    pub fn stretch(&self) -> SymmetricKey {
        let hkdf = hkdf::Hkdf::<Sha256>::from_prk(self.0.expose_secret().as_slice())
            .expect("32-byte PRK is always long enough for HKDF-SHA256");
        let mut enc = Zeroizing::new([0u8; KEY_LEN]);
        let mut mac = Zeroizing::new([0u8; MAC_LEN]);
        hkdf.expand(b"enc", enc.as_mut())
            .expect("32-byte expand output is within HKDF limits");
        hkdf.expand(b"mac", mac.as_mut())
            .expect("32-byte expand output is within HKDF limits");
        SymmetricKey {
            enc: SecretBox::new(Box::new(*enc)),
            mac: Some(SecretBox::new(Box::new(*mac))),
        }
    }

    /// Unwrap the account's user key (`profile.key` / token `Key`).
    ///
    /// Modern accounts wrap it as a type-2 `EncString` under the *stretched*
    /// master key. Pre-stretch accounts wrap it as a type-0 `EncString` under
    /// the master key itself; those still exist in the wild, so both are
    /// handled — and the two are never confused, because the envelope type
    /// selects the key.
    ///
    /// # Errors
    ///
    /// Returns a named envelope, integrity, padding, or key-length error when
    /// the wrapped user key cannot be safely decrypted.
    pub fn decrypt_user_key(&self, wrapped: &EncString) -> Result<SymmetricKey> {
        let plaintext = match wrapped.enc_type() {
            EncType::AesCbc256B64 => {
                let legacy = SymmetricKey::from_bytes(self.0.expose_secret().as_slice())?;
                legacy.decrypt(wrapped)?
            }
            EncType::AesCbc256HmacSha256B64 => self.stretch().decrypt(wrapped)?,
        };
        SymmetricKey::from_bytes(&plaintext)
    }

    /// Test/fixture support: build a master key from raw bytes.
    #[must_use]
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(SecretBox::new(Box::new(bytes)))
    }
}

/// A symmetric vault key: 32-byte AES key, plus a 32-byte HMAC key when the
/// key is a modern (type-2 capable) one.
pub struct SymmetricKey {
    enc: SecretBox<[u8; KEY_LEN]>,
    mac: Option<SecretBox<[u8; MAC_LEN]>>,
}

impl SymmetricKey {
    /// 32 bytes → enc only (legacy); 64 bytes → enc || mac.
    ///
    /// # Errors
    ///
    /// Returns [`Error::InvalidKeyLength`] for every other input length.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        match bytes.len() {
            KEY_LEN => {
                let mut enc = [0u8; KEY_LEN];
                enc.copy_from_slice(bytes);
                Ok(Self {
                    enc: SecretBox::new(Box::new(enc)),
                    mac: None,
                })
            }
            len if len == KEY_LEN + MAC_LEN => {
                let mut enc = [0u8; KEY_LEN];
                let mut mac = [0u8; MAC_LEN];
                enc.copy_from_slice(&bytes[..KEY_LEN]);
                mac.copy_from_slice(&bytes[KEY_LEN..]);
                Ok(Self {
                    enc: SecretBox::new(Box::new(enc)),
                    mac: Some(SecretBox::new(Box::new(mac))),
                })
            }
            other => Err(Error::InvalidKeyLength(other)),
        }
    }

    /// True when this key can authenticate type-2 `EncString` values.
    #[must_use]
    pub fn has_mac(&self) -> bool {
        self.mac.is_some()
    }

    /// Decrypt an `EncString` to raw bytes. Type 2 verifies the MAC in constant
    /// time *before* touching the ciphertext; type 7 is refused by name.
    ///
    /// # Errors
    ///
    /// Returns a named key-kind, integrity, envelope, key-length, or padding
    /// error when the value cannot be safely decrypted.
    pub fn decrypt(&self, value: &EncString) -> Result<Zeroizing<Vec<u8>>> {
        match value.enc_type {
            EncType::AesCbc256B64 => {
                if self.mac.is_some() {
                    return Err(Error::KeyKindMismatch {
                        enc_type: EncType::AesCbc256B64 as u8,
                        reason: "an unauthenticated type-0 EncString must not be opened with an \
                                 authenticated key — that silently drops integrity",
                    });
                }
                self.decrypt_cbc(value)
            }
            EncType::AesCbc256HmacSha256B64 => {
                let mac_key = self.mac.as_ref().ok_or(Error::KeyKindMismatch {
                    enc_type: EncType::AesCbc256HmacSha256B64 as u8,
                    reason: "this key has no MAC half, so the tag cannot be verified",
                })?;
                let expected = value.mac.as_deref().ok_or(Error::MalformedEncString(
                    "type 2 EncString is missing its MAC part",
                ))?;
                let mut hmac =
                    <HmacSha256 as hmac::KeyInit>::new_from_slice(mac_key.expose_secret())
                        .map_err(|_| Error::InvalidKeyLength(MAC_LEN))?;
                hmac.update(&value.iv);
                hmac.update(&value.data);
                // Constant time. Never `==`.
                hmac.verify_slice(expected)
                    .map_err(|_| Error::MacMismatch)?;
                self.decrypt_cbc(value)
            }
        }
    }

    /// Decrypt an `EncString` that is known to hold UTF-8.
    ///
    /// # Errors
    ///
    /// Returns the errors from [`Self::decrypt`], or [`Error::NotUtf8`] when
    /// the authenticated plaintext is not UTF-8.
    pub fn decrypt_string(&self, value: &EncString) -> Result<Zeroizing<String>> {
        let bytes = self.decrypt(value)?;
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| Error::NotUtf8)?
            .to_owned();
        Ok(Zeroizing::new(text))
    }

    fn decrypt_cbc(&self, value: &EncString) -> Result<Zeroizing<Vec<u8>>> {
        if value.iv.len() != AES_BLOCK {
            return Err(Error::MalformedEncString("IV must be 16 bytes"));
        }
        if value.data.is_empty() || value.data.len() % AES_BLOCK != 0 {
            return Err(Error::MalformedEncString(
                "ciphertext must be a non-zero multiple of the AES block size",
            ));
        }
        let cipher = Aes256CbcDec::new_from_slices(self.enc.expose_secret().as_slice(), &value.iv)
            .map_err(|_| Error::InvalidKeyLength(KEY_LEN))?;
        let plaintext = cipher
            .decrypt_padded_vec::<Pkcs7>(&value.data)
            .map_err(|_| Error::Padding)?;
        Ok(Zeroizing::new(plaintext))
    }

    /// Encrypt with a caller-supplied IV. Deterministic on purpose: this is
    /// how the committed crypto vectors and API fixtures are generated. Real
    /// vault writes are out of scope for a consume-client.
    ///
    /// # Errors
    ///
    /// Returns [`Error::InvalidKeyLength`] if the fixed key material cannot be
    /// accepted by the selected cipher or MAC implementation.
    pub fn encrypt_with_iv(&self, plaintext: &[u8], iv: [u8; AES_BLOCK]) -> Result<EncString> {
        let cipher = Aes256CbcEnc::new_from_slices(self.enc.expose_secret().as_slice(), &iv)
            .map_err(|_| Error::InvalidKeyLength(KEY_LEN))?;
        let data = cipher.encrypt_padded_vec::<Pkcs7>(plaintext);
        match self.mac.as_ref() {
            Some(mac_key) => {
                let mut hmac =
                    <HmacSha256 as hmac::KeyInit>::new_from_slice(mac_key.expose_secret())
                        .map_err(|_| Error::InvalidKeyLength(MAC_LEN))?;
                hmac.update(&iv);
                hmac.update(&data);
                Ok(EncString {
                    enc_type: EncType::AesCbc256HmacSha256B64,
                    iv: iv.to_vec(),
                    data,
                    mac: Some(hmac.finalize().into_bytes().to_vec()),
                })
            }
            None => Ok(EncString {
                enc_type: EncType::AesCbc256B64,
                iv: iv.to_vec(),
                data,
                mac: None,
            }),
        }
    }

    /// Test/fixture support: the raw key material, as `enc || mac`.
    /// Deliberately `Zeroizing` and deliberately not a `Display`/`Serialize`.
    #[must_use]
    pub fn to_bytes(&self) -> Zeroizing<Vec<u8>> {
        let mut out = Vec::with_capacity(KEY_LEN + MAC_LEN);
        out.extend_from_slice(self.enc.expose_secret().as_slice());
        if let Some(mac) = self.mac.as_ref() {
            out.extend_from_slice(mac.expose_secret().as_slice());
        }
        Zeroizing::new(out)
    }
}

/// The `EncString` types Bitwarden has minted. Only 0 and 2 are implemented;
/// every other value is refused by name at parse time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum EncType {
    /// `0.iv|data` — AES-256-CBC, unauthenticated. Legacy.
    AesCbc256B64 = 0,
    /// `2.iv|data|mac` — AES-256-CBC + HMAC-SHA256. The current standard.
    AesCbc256HmacSha256B64 = 2,
}

/// A parsed `{type}.{base64 parts joined by |}` value.
///
/// Parsing is total: every malformed input yields a named error, never a
/// panic. `Display` round-trips the wire form exactly.
#[derive(Clone, PartialEq, Eq)]
pub struct EncString {
    enc_type: EncType,
    iv: Vec<u8>,
    data: Vec<u8>,
    mac: Option<Vec<u8>>,
}

impl EncString {
    /// The envelope type (0 or 2 — everything else fails to parse).
    #[must_use]
    pub fn enc_type(&self) -> EncType {
        self.enc_type
    }

    /// Parse, mapping the empty string to `None` rather than an error. The
    /// Bitwarden API uses `""` and `null` interchangeably for absent fields.
    ///
    /// # Errors
    ///
    /// Returns a named parse error when a nonempty value is not a supported,
    /// structurally valid `EncString`.
    pub fn parse_optional(raw: Option<&str>) -> Result<Option<Self>> {
        match raw.map(str::trim) {
            None | Some("") => Ok(None),
            Some(value) => value.parse().map(Some),
        }
    }
}

impl FromStr for EncString {
    type Err = Error;

    fn from_str(raw: &str) -> Result<Self> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err(Error::MalformedEncString("empty EncString"));
        }
        let (tag, body) = raw
            .split_once('.')
            .ok_or(Error::MalformedEncString("missing `{type}.` prefix"))?;
        let enc_type = match tag {
            "0" => EncType::AesCbc256B64,
            "2" => EncType::AesCbc256HmacSha256B64,
            "7" => return Err(Error::CoseEncryptUnsupported),
            "1" | "3" | "4" | "5" | "6" => {
                // `tag` is one ASCII digit here, so the parse cannot fail.
                let value = tag.parse::<u8>().unwrap_or(0);
                return Err(Error::UnsupportedEncStringType(value));
            }
            other => return Err(Error::UnknownEncStringType(other.chars().take(8).collect())),
        };
        let mut parts = body.split('|');
        let iv = parts.next().unwrap_or_default();
        let data = parts
            .next()
            .ok_or(Error::MalformedEncString("missing ciphertext part"))?;
        let mac = parts.next();
        if parts.next().is_some() {
            return Err(Error::MalformedEncString("too many `|`-separated parts"));
        }
        match (enc_type, mac) {
            (EncType::AesCbc256B64, Some(_)) => {
                return Err(Error::MalformedEncString("type 0 takes exactly 2 parts"))
            }
            (EncType::AesCbc256HmacSha256B64, None) => {
                return Err(Error::MalformedEncString("type 2 takes exactly 3 parts"))
            }
            _ => {}
        }
        let iv = decode_part(iv, "IV")?;
        let data = decode_part(data, "ciphertext")?;
        let mac = mac.map(|m| decode_part(m, "MAC")).transpose()?;
        if iv.len() != AES_BLOCK {
            return Err(Error::MalformedEncString("IV must be 16 bytes"));
        }
        if data.is_empty() || data.len() % AES_BLOCK != 0 {
            return Err(Error::MalformedEncString(
                "ciphertext must be a non-zero multiple of the AES block size",
            ));
        }
        if let Some(mac) = mac.as_ref() {
            if mac.len() != MAC_LEN {
                return Err(Error::MalformedEncString("MAC must be 32 bytes"));
            }
        }
        Ok(EncString {
            enc_type,
            iv,
            data,
            mac,
        })
    }
}

fn decode_part(raw: &str, what: &'static str) -> Result<Vec<u8>> {
    if raw.is_empty() {
        return Err(match what {
            "IV" => Error::MalformedEncString("empty IV part"),
            "ciphertext" => Error::MalformedEncString("empty ciphertext part"),
            _ => Error::MalformedEncString("empty MAC part"),
        });
    }
    B64.decode(raw).map_err(|_| match what {
        "IV" => Error::MalformedEncString("IV is not base64"),
        "ciphertext" => Error::MalformedEncString("ciphertext is not base64"),
        _ => Error::MalformedEncString("MAC is not base64"),
    })
}

impl fmt::Display for EncString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}.{}|{}",
            self.enc_type as u8,
            B64.encode(&self.iv),
            B64.encode(&self.data)
        )?;
        if let Some(mac) = self.mac.as_ref() {
            write!(f, "|{}", B64.encode(mac))?;
        }
        Ok(())
    }
}

/// Ciphertext is not a secret; the key is. Showing the envelope in a debug log
/// is safe and makes malformed-input triage possible.
impl fmt::Debug for EncString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EncString")
            .field("type", &(self.enc_type as u8))
            .field("iv_len", &self.iv.len())
            .field("data_len", &self.data.len())
            .field("mac_len", &self.mac.as_ref().map(Vec::len))
            .finish()
    }
}

#[cfg(test)]
#[path = "crypto_tests.rs"]
mod tests;
