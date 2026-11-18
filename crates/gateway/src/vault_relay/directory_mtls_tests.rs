//! Directory authorization requires its own service-binding operations.

use super::*;

#[tokio::test]
async fn directory_routes_require_an_admitted_operation_on_the_peer() {
    let pki = pki();
    let reader = client_leaf(&pki.ca, "reader.test");
    let writer = client_leaf(&pki.ca, "writer.test");
    let stranger = client_leaf(&pki.ca, "stranger.test");
    let mut reader_binding = binding(
        PeerIdentitySelector::DnsName("reader.test".into()),
        &[operations::VAULT_RELAY_DIRECTORY_LIST],
    );
    reader_binding.id = "directory-reader".into();
    let mut writer_binding = binding(
        PeerIdentitySelector::DnsName("writer.test".into()),
        &[operations::VAULT_RELAY_DIRECTORY_CREATE],
    );
    writer_binding.id = "directory-writer".into();
    let snapshot_only = client_leaf(&pki.ca, "snapshot.test");
    let mut snapshot_binding = binding(
        PeerIdentitySelector::DnsName("snapshot.test".into()),
        &[
            operations::VAULT_RELAY_SNAPSHOT_READ,
            operations::VAULT_RELAY_SNAPSHOT_WRITE,
        ],
    );
    snapshot_binding.id = "snapshot-only".into();
    let bindings = ServiceBindingSet {
        revision: 1,
        bindings: vec![reader_binding, writer_binding, snapshot_binding],
    };
    let addr = serve(&pki, bindings).await;
    let list = |http: reqwest::Client| async move {
        http.get(url(addr, "/v1/org-vaults?owner=ada"))
            .header("x-opensesame-principal", "ada")
            .send()
            .await
            .expect("list request")
    };
    let create = |http: reqwest::Client| async move {
        http.post(url(addr, "/v1/org-vaults"))
            .header("x-opensesame-principal", "ada")
            .json(&json!({ "ownerKind": "user", "owner": "ada", "slug": "personal" }))
            .send()
            .await
            .expect("create request")
    };

    let unknown = client(&pki, addr, Some(&stranger));
    assert_eq!(list(unknown.clone()).await.status(), StatusCode::FORBIDDEN);
    assert_eq!(create(unknown).await.status(), StatusCode::FORBIDDEN);

    let snapshot = client(&pki, addr, Some(&snapshot_only));
    assert_eq!(list(snapshot.clone()).await.status(), StatusCode::FORBIDDEN);
    assert_eq!(create(snapshot).await.status(), StatusCode::FORBIDDEN);

    let reader = client(&pki, addr, Some(&reader));
    let writer = client(&pki, addr, Some(&writer));
    assert_eq!(create(reader.clone()).await.status(), StatusCode::FORBIDDEN);
    assert_eq!(list(writer.clone()).await.status(), StatusCode::FORBIDDEN);
    assert_eq!(create(writer).await.status(), StatusCode::CREATED);
    let visible = list(reader).await;
    assert_eq!(visible.status(), StatusCode::OK);
    assert_eq!(
        visible.json::<serde_json::Value>().await.unwrap()["vaults"][0]["slug"],
        "personal"
    );
}
