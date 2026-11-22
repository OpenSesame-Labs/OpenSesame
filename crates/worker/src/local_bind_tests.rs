#[tokio::test]
async fn existing_local_binds_only_checked_loopback_addresses() {
    for address in ["127.0.0.1:0", "[::1]:0"] {
        let listen = crate::existing_local_listen(address).expect(address);
        let listener = tokio::net::TcpListener::bind(listen).await.unwrap();
        assert!(listener.local_addr().unwrap().ip().is_loopback());
    }

    for address in ["0.0.0.0:0", "[::]:0", "192.0.2.1:0", "localhost:0"] {
        assert!(crate::existing_local_listen(address).is_err(), "{address}");
    }
}
