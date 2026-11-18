use super::*;

#[test]
fn only_valid_upn_other_names_are_accepted() {
    let upn_oid = x509_parser::oid_registry::Oid::from(&UPN_OID).unwrap();
    let value = write_tlv(0xA0, &write_tlv(0x0C, b"ops@corp.example"));
    assert_eq!(
        general_names_to_sans(&[GeneralName::OtherName(upn_oid.clone(), &value)]).unwrap(),
        vec![SanEntry::Upn("ops@corp.example".to_owned())]
    );
    let unknown_oid = x509_parser::oid_registry::Oid::from(&[1, 2, 3]).unwrap();
    assert_eq!(
        general_names_to_sans(&[GeneralName::OtherName(unknown_oid, &value)]).unwrap_err(),
        PkiError::InvalidName
    );
    assert!(general_names_to_sans(&[GeneralName::OtherName(upn_oid, b"bad")]).is_err());
}
#[test]
fn upn_other_name_decoding_rejects_malformed_bodies() {
    let good = write_tlv(0xA0, &write_tlv(0x0C, b"ops@corp.example"));
    assert_eq!(decode_upn_value(&good).unwrap(), "ops@corp.example");
    assert!(decode_upn_value(&write_tlv(0xA1, &write_tlv(0x0C, b"x"))).is_err());
    assert!(decode_upn_value(&write_tlv(0xA0, &write_tlv(0x04, b"x"))).is_err());
    assert!(decode_upn_value(&[]).is_err());
    let trailing = {
        let mut bytes = write_tlv(0xA0, &write_tlv(0x0C, b"x"));
        bytes.push(0x00);
        bytes
    };
    assert!(decode_upn_value(&trailing).is_err());
}
