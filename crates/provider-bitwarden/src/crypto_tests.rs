//! Unit tests for [`crate::crypto`].
//!
//! A sibling file so the module itself stays inside its recorded size budget.

use super::*;

fn key64() -> SymmetricKey {
    let bytes: Vec<u8> = (0u8..64)
        .map(|i| i.wrapping_mul(7).wrapping_add(3))
        .collect();
    SymmetricKey::from_bytes(&bytes).unwrap()
}

fn key32() -> SymmetricKey {
    let bytes: Vec<u8> = (0u8..32)
        .map(|i| i.wrapping_mul(11).wrapping_add(5))
        .collect();
    SymmetricKey::from_bytes(&bytes).unwrap()
}

#[test]
fn normalize_email_trims_and_lowercases() {
    assert_eq!(normalize_email("  User@Example.COM \n"), "user@example.com");
}

#[test]
fn type2_round_trips_and_displays_the_wire_form() {
    let key = key64();
    let enc = key.encrypt_with_iv(b"hunter2", [9u8; 16]).unwrap();
    assert_eq!(enc.enc_type(), EncType::AesCbc256HmacSha256B64);
    let wire = enc.to_string();
    assert!(wire.starts_with("2."), "{wire}");
    assert_eq!(wire.split('|').count(), 3);
    let reparsed: EncString = wire.parse().unwrap();
    assert_eq!(reparsed, enc);
    assert_eq!(&*key.decrypt(&reparsed).unwrap(), b"hunter2");
    assert_eq!(&*key.decrypt_string(&reparsed).unwrap(), "hunter2");
}

#[test]
fn type0_round_trips_under_a_mac_less_key() {
    let key = key32();
    assert!(!key.has_mac());
    let enc = key.encrypt_with_iv(b"legacy", [1u8; 16]).unwrap();
    assert_eq!(enc.enc_type(), EncType::AesCbc256B64);
    let wire = enc.to_string();
    assert!(wire.starts_with("0."), "{wire}");
    assert_eq!(wire.split('|').count(), 2);
    assert_eq!(&*key.decrypt(&wire.parse().unwrap()).unwrap(), b"legacy");
}

#[test]
fn type7_is_refused_by_name_never_best_effort() {
    let error = "7.T0NPU0VOQ1JZUFQwCg==".parse::<EncString>().unwrap_err();
    assert_eq!(error.code(), "cose_encrypt_unsupported");
    assert!(matches!(error, Error::CoseEncryptUnsupported));
    let message = error.to_string();
    assert!(message.contains("type 7"), "{message}");
    assert!(message.contains("ADR 0052"), "{message}");
    assert!(message.contains("bw"), "{message}");
}

#[test]
fn rsa_and_retired_types_are_refused_explicitly() {
    for tag in [1u8, 3, 4, 5, 6] {
        let raw = format!("{tag}.aaaa|bbbb");
        let error = raw.parse::<EncString>().unwrap_err();
        assert_eq!(error.code(), "unsupported_enc_string_type", "type {tag}");
        assert!(matches!(error, Error::UnsupportedEncStringType(t) if t == tag));
    }
}

#[test]
fn unknown_type_tags_are_named_and_bounded() {
    let error = "99999999999999.a|b".parse::<EncString>().unwrap_err();
    assert_eq!(error.code(), "unknown_enc_string_type");
    // The echoed tag is truncated so a hostile server cannot write an
    // arbitrarily long string into an operator's terminal.
    assert!(error.to_string().len() < 64, "{error}");
}

/// Table-driven: no malformed `EncString` may panic, and every one of them
/// must produce a named error rather than a partial parse.
#[test]
fn malformed_enc_strings_never_panic() {
    let key = key64();
    let good = key
        .encrypt_with_iv(b"payload", [4u8; 16])
        .unwrap()
        .to_string();
    let (head, tail) = good.split_once('.').unwrap();
    let mut parts = tail.split('|');
    let iv = parts.next().unwrap().to_owned();
    let data = parts.next().unwrap().to_owned();
    let mac = parts.next().unwrap().to_owned();
    assert_eq!(head, "2");

    let cases: Vec<(&str, String)> = vec![
        ("empty", String::new()),
        ("whitespace", "   ".into()),
        ("no dot", "2aaaa|bbbb".into()),
        ("dot only", ".".into()),
        ("type only", "2.".into()),
        ("type 2, one part", format!("2.{iv}")),
        ("type 2, two parts", format!("2.{iv}|{data}")),
        ("type 2, four parts", format!("2.{iv}|{data}|{mac}|{mac}")),
        ("type 0, three parts", format!("0.{iv}|{data}|{mac}")),
        ("empty iv", format!("2.|{data}|{mac}")),
        ("empty data", format!("2.{iv}||{mac}")),
        ("empty mac", format!("2.{iv}|{data}|")),
        ("iv not base64", format!("2.!!!!|{data}|{mac}")),
        ("data not base64", format!("2.{iv}|!!!!|{mac}")),
        ("mac not base64", format!("2.{iv}|{data}|!!!!")),
        (
            "short iv",
            format!("2.{}|{data}|{mac}", B64.encode([0u8; 8])),
        ),
        (
            "long iv",
            format!("2.{}|{data}|{mac}", B64.encode([0u8; 32])),
        ),
        (
            "short mac",
            format!("2.{iv}|{data}|{}", B64.encode([0u8; 16])),
        ),
        (
            "unaligned ciphertext",
            format!("2.{iv}|{}|{mac}", B64.encode([0u8; 17])),
        ),
        (
            "empty ciphertext bytes",
            format!("2.{iv}|{}|{mac}", B64.encode([0u8; 0])),
        ),
        ("truncated wire", good[..good.len() / 2].to_owned()),
        ("negative type", "-1.a|b".into()),
        ("float type", "2.5.a|b".into()),
        ("unicode type", "٢.a|b".into()),
        ("null byte", "2.\0|b|c".into()),
    ];
    for (name, raw) in cases {
        match raw.parse::<EncString>() {
            Ok(parsed) => panic!("`{name}` unexpectedly parsed to {parsed:?}"),
            Err(error) => {
                // A named error, and never an empty message.
                assert!(!error.code().is_empty(), "{name}");
                assert!(!error.to_string().is_empty(), "{name}");
            }
        }
    }
}

#[test]
fn a_tampered_mac_is_rejected_in_constant_time() {
    let key = key64();
    let enc = key.encrypt_with_iv(b"do not tamper", [2u8; 16]).unwrap();
    let wire = enc.to_string();
    let mut parts: Vec<String> = wire[2..].split('|').map(str::to_owned).collect();
    let mut mac = B64.decode(&parts[2]).unwrap();
    mac[0] ^= 0x01;
    parts[2] = B64.encode(&mac);
    let tampered: EncString = format!("2.{}", parts.join("|")).parse().unwrap();
    let error = key.decrypt(&tampered).unwrap_err();
    assert_eq!(error.code(), "mac_mismatch");
}

#[test]
fn tampered_ciphertext_fails_the_mac_before_decryption() {
    let key = key64();
    let enc = key.encrypt_with_iv(b"do not tamper", [3u8; 16]).unwrap();
    let wire = enc.to_string();
    let mut parts: Vec<String> = wire[2..].split('|').map(str::to_owned).collect();
    let mut data = B64.decode(&parts[1]).unwrap();
    data[0] ^= 0xff;
    parts[1] = B64.encode(&data);
    let tampered: EncString = format!("2.{}", parts.join("|")).parse().unwrap();
    assert_eq!(key.decrypt(&tampered).unwrap_err().code(), "mac_mismatch");
}

#[test]
fn a_wrong_key_is_indistinguishable_from_tampering() {
    let enc = key64().encrypt_with_iv(b"secret", [5u8; 16]).unwrap();
    let other: Vec<u8> = (0u8..64).map(|i| i.wrapping_mul(13)).collect();
    let error = SymmetricKey::from_bytes(&other)
        .expect("64 bytes")
        .decrypt(&enc)
        .unwrap_err();
    assert_eq!(error.code(), "mac_mismatch");
}

#[test]
fn key_kinds_are_never_mixed() {
    let authenticated = key64();
    let legacy = key32();
    let type2 = authenticated.encrypt_with_iv(b"x", [6u8; 16]).unwrap();
    let type0 = legacy.encrypt_with_iv(b"x", [6u8; 16]).unwrap();
    assert_eq!(
        legacy.decrypt(&type2).unwrap_err().code(),
        "key_kind_mismatch"
    );
    assert_eq!(
        authenticated.decrypt(&type0).unwrap_err().code(),
        "key_kind_mismatch"
    );
}

#[test]
fn keys_must_be_32_or_64_bytes() {
    for len in [0usize, 1, 16, 31, 33, 63, 65, 128] {
        // `.err()` rather than `.unwrap_err()`: `SymmetricKey` has no
        // `Debug`, so the compiler itself enforces that a key can never be
        // printed by a test helper.
        let error = SymmetricKey::from_bytes(&vec![0u8; len])
            .err()
            .expect("rejected");
        assert!(matches!(error, Error::InvalidKeyLength(l) if l == len));
    }
    assert!(SymmetricKey::from_bytes(&[0u8; 32]).is_ok());
    assert!(SymmetricKey::from_bytes(&[0u8; 64]).is_ok());
}

#[test]
fn non_utf8_plaintext_is_named_not_lossy() {
    let key = key64();
    let enc = key.encrypt_with_iv(&[0xff, 0xfe, 0xfd], [7u8; 16]).unwrap();
    assert_eq!(key.decrypt_string(&enc).unwrap_err().code(), "not_utf8");
    assert_eq!(&*key.decrypt(&enc).unwrap(), &[0xff, 0xfe, 0xfd]);
}

#[test]
fn parse_optional_maps_absent_and_empty_to_none() {
    assert!(EncString::parse_optional(None).unwrap().is_none());
    assert!(EncString::parse_optional(Some("")).unwrap().is_none());
    assert!(EncString::parse_optional(Some("   ")).unwrap().is_none());
    assert_eq!(
        EncString::parse_optional(Some("7.aaaa"))
            .unwrap_err()
            .code(),
        "cose_encrypt_unsupported"
    );
}

#[test]
fn stretching_is_deterministic_and_splits_enc_from_mac() {
    let master = MasterKey::from_bytes([42u8; 32]);
    let a = master.stretch();
    let b = master.stretch();
    assert_eq!(a.to_bytes().to_vec(), b.to_bytes().to_vec());
    let bytes = a.to_bytes();
    assert_eq!(bytes.len(), 64);
    assert_ne!(&bytes[..32], &bytes[32..], "enc and mac halves must differ");
    assert!(a.has_mac());
}

#[test]
fn a_legacy_type0_user_key_unwraps_under_the_master_key_itself() {
    let master_bytes = [77u8; 32];
    let master = MasterKey::from_bytes(master_bytes);
    // Pre-stretch accounts wrapped the user key with the master key.
    let raw_master = SymmetricKey::from_bytes(&master_bytes).unwrap();
    let user_key_bytes: Vec<u8> = (0u8..64).map(|i| i.wrapping_mul(5)).collect();
    let wrapped = raw_master
        .encrypt_with_iv(&user_key_bytes, [8u8; 16])
        .unwrap();
    assert_eq!(wrapped.enc_type(), EncType::AesCbc256B64);
    let unwrapped = master.decrypt_user_key(&wrapped).unwrap();
    assert_eq!(unwrapped.to_bytes().to_vec(), user_key_bytes);
}

#[test]
fn a_modern_type2_user_key_unwraps_under_the_stretched_key() {
    let master = MasterKey::from_bytes([21u8; 32]);
    let user_key_bytes: Vec<u8> = (0u8..64).map(|i| i.wrapping_add(9)).collect();
    let wrapped = master
        .stretch()
        .encrypt_with_iv(&user_key_bytes, [10u8; 16])
        .unwrap();
    assert_eq!(wrapped.enc_type(), EncType::AesCbc256HmacSha256B64);
    assert_eq!(
        master
            .decrypt_user_key(&wrapped)
            .unwrap()
            .to_bytes()
            .to_vec(),
        user_key_bytes
    );
}

#[test]
fn a_user_key_that_is_not_32_or_64_bytes_is_rejected() {
    let master = MasterKey::from_bytes([1u8; 32]);
    let wrapped = master
        .stretch()
        .encrypt_with_iv(&[0u8; 48], [11u8; 16])
        .unwrap();
    assert_eq!(
        master
            .decrypt_user_key(&wrapped)
            .err()
            .expect("48-byte user key is rejected")
            .code(),
        "invalid_key_length"
    );
}

#[test]
fn debug_of_an_enc_string_shows_shape_not_content() {
    let enc = key64().encrypt_with_iv(b"top secret", [12u8; 16]).unwrap();
    let rendered = format!("{enc:?}");
    assert!(rendered.contains("iv_len: 16"), "{rendered}");
    assert!(!rendered.contains("top secret"), "{rendered}");
}
