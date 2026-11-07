//! Published known answers for the hash, MAC and KDF primitives the vault
//! envelopes are built from.
//!
//! Every derived key in this crate is SHA-256, HMAC-SHA-256, HKDF-SHA-256 or
//! PBKDF2-HMAC-SHA-256 underneath. These vectors come from the RFCs and FIPS
//! publications, not from a run of this code, so they hold across any upgrade
//! of the `RustCrypto` crates: a failure here means the primitive changed, and
//! every vault already sealed under it would stop opening.

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

#[test]
fn sha256_matches_fips_180_4() {
    assert_eq!(
        Sha256::digest(b"abc").as_slice(),
        unhex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad").as_slice()
    );
}

/// Digest strings across the workspace are written `format!("{:x}", digest)`;
/// the hex rendering is part of every persisted `sha256:` identifier.
#[test]
fn a_digest_formats_as_contiguous_lowercase_hex() {
    assert_eq!(
        format!("sha256:{:x}", Sha256::digest(b"abc")),
        "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    let mut mac = Hmac::<Sha256>::new_from_slice(b"Jefe").expect("any key length");
    mac.update(b"what do ya want for nothing?");
    assert_eq!(
        format!("{:x}", mac.finalize().into_bytes()),
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    );
}

#[test]
fn hmac_sha256_matches_rfc_4231_case_2() {
    let mut mac = Hmac::<Sha256>::new_from_slice(b"Jefe").expect("any key length");
    mac.update(b"what do ya want for nothing?");
    assert_eq!(
        mac.finalize().into_bytes().as_slice(),
        unhex("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843").as_slice()
    );
}

#[test]
fn hkdf_sha256_matches_rfc_5869_case_1() {
    let ikm = [0x0bu8; 22];
    let salt = unhex("000102030405060708090a0b0c");
    let info = unhex("f0f1f2f3f4f5f6f7f8f9");
    let (prk, hk) = Hkdf::<Sha256>::extract(Some(&salt), &ikm);
    assert_eq!(
        prk.as_slice(),
        unhex("077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5").as_slice()
    );
    let mut okm = [0u8; 42];
    hk.expand(&info, &mut okm)
        .expect("42 bytes is a valid length");
    assert_eq!(
        okm.as_slice(),
        unhex(
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        )
        .as_slice()
    );
}

#[test]
fn hkdf_sha256_matches_rfc_5869_case_3_without_salt_or_info() {
    let ikm = [0x0bu8; 22];
    let mut okm = [0u8; 42];
    Hkdf::<Sha256>::new(None, &ikm)
        .expand(&[], &mut okm)
        .expect("42 bytes is a valid length");
    assert_eq!(
        okm.as_slice(),
        unhex(
            "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8"
        )
        .as_slice()
    );
}

#[test]
fn pbkdf2_hmac_sha256_matches_rfc_7914_section_11() {
    let mut out = [0u8; 64];
    pbkdf2::pbkdf2_hmac::<Sha256>(b"passwd", b"salt", 1, &mut out);
    assert_eq!(
        out.as_slice(),
        unhex(
            "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc\
             49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783"
        )
        .as_slice()
    );
}
