#[tokio::test]
async fn existing_local_binds_only_checked_loopback_addresses() {
    let listener = crate::bind_local("127.0.0.1:0").await.unwrap();
    assert!(listener.local_addr().unwrap().ip().is_loopback());
    let listener = crate::bind_local("localhost:0").await.unwrap();
    assert!(listener.local_addr().unwrap().ip().is_loopback());

    for address in ["0.0.0.0:0", "[::]:0", "192.0.2.1:0"] {
        assert!(crate::bind_local(address).await.is_err(), "{address}");
    }
    let mixed = [
        "127.0.0.1:0".parse().unwrap(),
        "192.0.2.1:0".parse().unwrap(),
    ];
    assert!(crate::validate_local_addresses(&mixed).is_err());
    assert!(crate::validate_local_addresses(&[]).is_err());
}
