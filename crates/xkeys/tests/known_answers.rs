//! Frozen answers for the bus seal: X25519 against RFC 7748, and one sealed
//! blob captured from a real run of [`opensesame_xkeys::seal`].
//!
//! A blob sealed yesterday must open tomorrow, through any upgrade of the
//! curve, KDF or AEAD crates. A failure here does not mean "regenerate the
//! blob" — it means the change would strand every message already on the bus.

use opensesame_xkeys::{open, XKeyPair};
use x25519_dalek::{PublicKey, StaticSecret};

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

fn key(s: &str) -> [u8; 32] {
    unhex(s).try_into().expect("32 bytes")
}

const ALICE_SECRET: &str = "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a";
const ALICE_PUBLIC: &str = "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a";
const BOB_SECRET: &str = "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb";
const BOB_PUBLIC: &str = "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f";
const SHARED: &str = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";

#[test]
fn x25519_matches_rfc_7748_section_6_1() {
    let alice = StaticSecret::from(key(ALICE_SECRET));
    let bob = StaticSecret::from(key(BOB_SECRET));
    assert_eq!(PublicKey::from(&alice).as_bytes(), &key(ALICE_PUBLIC));
    assert_eq!(PublicKey::from(&bob).as_bytes(), &key(BOB_PUBLIC));
    let bob_public = PublicKey::from(key(BOB_PUBLIC));
    let alice_public = PublicKey::from(key(ALICE_PUBLIC));
    assert_eq!(alice.diffie_hellman(&bob_public).as_bytes(), &key(SHARED));
    assert_eq!(bob.diffie_hellman(&alice_public).as_bytes(), &key(SHARED));
}

#[test]
fn the_keypair_derives_the_rfc_public_key() {
    let bob = XKeyPair::from_secret_bytes(key(BOB_SECRET));
    assert_eq!(bob.public_bytes(), key(BOB_PUBLIC));
}

/// Sealed to Bob's RFC 7748 public key, captured once from `seal`.
const GOLDEN_SEALED: &str = "019d5f76659fe8b18876450c41b831d0d0e2a36f17c1389c80cee6a56ce0e5a2\
564e208f2c1bb7c7ca175779e0f22a5201dab7f1449707d1e1cdb99b6e0deda82d1b975c7be3e5399367158c940b7301ff9e23ae19655e84d6f39ea241e7a8";
const GOLDEN_PLAINTEXT: &[u8] = b"xkeys golden plaintext";

#[test]
fn a_blob_sealed_earlier_still_opens() {
    let bob = XKeyPair::from_secret_bytes(key(BOB_SECRET));
    let opened = open(&unhex(GOLDEN_SEALED), &bob).expect("golden blob opens");
    assert_eq!(opened, GOLDEN_PLAINTEXT);
}

#[test]
fn the_golden_blob_is_authenticated() {
    let bob = XKeyPair::from_secret_bytes(key(BOB_SECRET));
    let mut tampered = unhex(GOLDEN_SEALED);
    let last = tampered.len() - 1;
    tampered[last] ^= 1;
    assert!(open(&tampered, &bob).is_err());
}

#[test]
#[ignore = "prints a fresh golden blob; run by hand only when adding a vector"]
fn print_a_fresh_golden_blob() {
    let blob =
        opensesame_xkeys::seal(GOLDEN_PLAINTEXT, &PublicKey::from(key(BOB_PUBLIC))).expect("seal");
    let hex = blob.iter().fold(String::new(), |mut out, b| {
        use std::fmt::Write as _;
        let _ = write!(out, "{b:02x}");
        out
    });
    println!("GOLDEN={hex}");
}
