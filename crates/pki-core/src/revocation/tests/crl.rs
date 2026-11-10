use super::*;

#[test]
fn a_crl_round_trips_its_number_window_and_serials() {
    let root = root();
    let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
    let der = build_crl(
        &root.certificate_pem,
        &root.key,
        &entries(),
        42,
        now,
        now + Duration::days(7),
    )
    .unwrap();
    let facts = parse_crl(&der).unwrap();
    assert_eq!(facts.crl_number, 42);
    assert_eq!(facts.this_update, now);
    assert_eq!(facts.next_update, Some(now + Duration::days(7)));
    assert_eq!(
        facts.serials,
        ["0102030405060708090a0b0c0d0e0f10", "aabbccdd"]
    );
    verify_crl(&der, &root.certificate_pem).unwrap();
}

#[test]
fn an_empty_crl_is_still_a_valid_signed_list() {
    let root = root();
    let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
    let der = build_crl(
        &root.certificate_pem,
        &root.key,
        &[],
        1,
        now,
        now + Duration::days(1),
    )
    .unwrap();
    assert!(parse_crl(&der).unwrap().serials.is_empty());
    verify_crl(&der, &root.certificate_pem).unwrap();
    let pem = crl_to_pem(&der);
    assert!(pem.starts_with("-----BEGIN X509 CRL-----"));
    assert_eq!(
        x509::parse_pem_blocks(&pem, x509::LABEL_CRL, 1).unwrap()[0],
        der
    );
}

#[test]
fn adversarial_a_tampered_crl_fails_verification() {
    let root = root();
    let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
    let mut der = build_crl(
        &root.certificate_pem,
        &root.key,
        &entries(),
        7,
        now,
        now + Duration::days(1),
    )
    .unwrap();
    let position = der.len() / 4;
    der[position] ^= 0xff;
    assert!(verify_crl(&der, &root.certificate_pem).is_err());
}

#[test]
fn adversarial_a_crl_from_another_authority_fails_verification() {
    let first = root();
    let second = root();
    let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
    let der = build_crl(
        &first.certificate_pem,
        &first.key,
        &entries(),
        1,
        now,
        now + Duration::days(1),
    )
    .unwrap();
    assert_eq!(
        verify_crl(&der, &second.certificate_pem).unwrap_err(),
        PkiError::SignatureInvalid
    );
}

#[test]
fn adversarial_crl_building_refuses_bad_windows_reasons_and_serials() {
    let root = root();
    let now = OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
    assert_eq!(
        build_crl(&root.certificate_pem, &root.key, &[], 1, now, now).unwrap_err(),
        PkiError::InvalidValidity
    );
    let bad_reason = vec![RevokedEntry {
        serial_hex: "01".into(),
        revoked_at: now,
        reason_code: 7,
    }];
    assert_eq!(
        build_crl(
            &root.certificate_pem,
            &root.key,
            &bad_reason,
            1,
            now,
            now + Duration::days(1)
        )
        .unwrap_err(),
        PkiError::CrlBuild
    );
    let bad_serial = vec![RevokedEntry {
        serial_hex: "zz".into(),
        revoked_at: now,
        reason_code: 0,
    }];
    assert_eq!(
        build_crl(
            &root.certificate_pem,
            &root.key,
            &bad_serial,
            1,
            now,
            now + Duration::days(1)
        )
        .unwrap_err(),
        PkiError::CrlBuild
    );
}

#[test]
fn adversarial_hostile_crl_bytes_never_panic() {
    for hostile in [
        Vec::new(),
        vec![0x00],
        vec![0x30, 0x82, 0xff, 0xff],
        vec![0xffu8; 4096],
    ] {
        assert!(parse_crl(&hostile).is_err());
    }
    let huge = vec![0x41u8; MAX_REVOCATION_BYTES + 1];
    assert_eq!(parse_crl(&huge).unwrap_err(), PkiError::TooLarge);
}
