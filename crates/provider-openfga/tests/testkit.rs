#![cfg(feature = "testkit")]

use opensesame_provider_openfga::{testkit::FakeRemotePdp, OpenFgaError, RemotePdp, TupleKey};

fn tuple(user: &str, relation: &str, object: &str) -> TupleKey {
    TupleKey {
        user: user.into(),
        relation: relation.into(),
        object: object.into(),
    }
}

#[tokio::test]
async fn exact_permissions_are_explicit_and_revocable() {
    let pdp = FakeRemotePdp::new();
    let allowed = tuple("user:alice", "reader", "vault_item:one");
    assert!(!pdp.check(&allowed).await.unwrap());
    pdp.allow(&allowed).unwrap();
    pdp.allow(&allowed).unwrap();
    assert!(pdp.check(&allowed).await.unwrap());
    for other in [
        tuple("user:bob", "reader", "vault_item:one"),
        tuple("user:alice", "writer", "vault_item:one"),
        tuple("user:alice", "reader", "vault_item:two"),
    ] {
        assert!(!pdp.check(&other).await.unwrap());
    }
    // Wildcards and usersets are literal keys, never extra grants.
    pdp.allow(&tuple("user:*", "reader", "vault_item:two"))
        .unwrap();
    assert!(!pdp
        .check(&tuple("user:alice", "reader", "vault_item:two"))
        .await
        .unwrap());
    pdp.revoke(&allowed).unwrap();
    pdp.revoke(&allowed).unwrap();
    assert!(!pdp.check(&allowed).await.unwrap());
}

#[tokio::test]
async fn outages_reset_and_close_are_fail_closed_across_clones() {
    let pdp = FakeRemotePdp::new();
    let shared = pdp.clone();
    let other = FakeRemotePdp::new();
    let allowed = tuple("user:alice", "user", "connection:one");
    pdp.allow(&allowed).unwrap();
    assert!(shared.check(&allowed).await.unwrap());
    assert!(!other.check(&allowed).await.unwrap());

    shared.set_unavailable(true).unwrap();
    assert!(matches!(
        pdp.check(&allowed).await,
        Err(OpenFgaError::Unavailable(_))
    ));
    shared.set_unavailable(false).unwrap();
    assert!(pdp.check(&allowed).await.unwrap());
    shared.reset().unwrap();
    assert!(!pdp.check(&allowed).await.unwrap());
    pdp.allow(&allowed).unwrap();
    shared.close().unwrap();
    shared.close().unwrap();
    assert!(matches!(
        pdp.check(&allowed).await,
        Err(OpenFgaError::Unavailable(_))
    ));
    assert!(pdp.allow(&allowed).is_err());
    assert!(pdp.reset().is_err());
}

#[tokio::test]
async fn malformed_keys_are_rejected_and_keys_are_not_delimiter_joined() {
    let pdp = FakeRemotePdp::new();
    let empty = tuple("", "reader", "vault_item:one");
    assert!(pdp.allow(&empty).is_err());
    assert!(pdp.check(&empty).await.is_err());

    let first = tuple("user:a#b", "c", "document:d");
    let second = tuple("user:a", "b#c", "document:d");
    pdp.allow(&first).unwrap();
    assert!(pdp.check(&first).await.unwrap());
    assert!(!pdp.check(&second).await.unwrap());
}
