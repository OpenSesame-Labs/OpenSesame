//! Native client sync ciphertext is bound to its owner's key and item identity.
use opensesame_client_core::{open_sync_blob, DeviceKey, SyncStore};

#[test]
fn independent_customer_keys_refuse_foreign_ciphertext_for_the_same_item_id() {
    let customer_a = DeviceKey::from_bytes([11; 32]);
    let customer_b = DeviceKey::from_bytes([22; 32]);
    let mut store_a = SyncStore::new("customer-a-device");
    let mut store_b = SyncStore::new("customer-b-device");
    let a = store_a
        .put_local(&customer_a, "shared-item-id", b"customer-a-secret")
        .unwrap();
    let b = store_b
        .put_local(&customer_b, "shared-item-id", b"customer-b-secret")
        .unwrap();
    assert_eq!(
        open_sync_blob(&customer_a, &a).unwrap(),
        b"customer-a-secret"
    );
    assert_eq!(
        open_sync_blob(&customer_b, &b).unwrap(),
        b"customer-b-secret"
    );
    assert!(open_sync_blob(&customer_b, &a).is_err());
    assert!(open_sync_blob(&customer_a, &b).is_err());
    let mut wrong_id = a.clone();
    wrong_id.id = "different-item-id".into();
    assert!(open_sync_blob(&customer_a, &wrong_id).is_err());
    let mut tampered = a;
    *tampered.ciphertext.last_mut().unwrap() ^= 1;
    assert!(open_sync_blob(&customer_a, &tampered).is_err());
}
