//! KV responses carry a receipt identifier, never its private opening.

use super::super::tests::{boot_org, facade, seed_connection, session};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use opensesame_domain::ReceiptId;
use tower::ServiceExt;

#[tokio::test]
async fn kv_response_and_stored_receipt_withhold_the_opening() {
    let (router, state) = facade().await;
    let organization = boot_org(&state);
    let subject = crate::test_principals::P26;
    let token = session(&state, subject, organization);
    seed_connection(
        &state,
        &organization,
        "opening",
        "github",
        Some(subject),
        "deny",
    )
    .await;
    let response = router
        .oneshot(
            Request::builder()
                .uri("/v1/secret/data/connections/opening")
                .header("X-Vault-Token", token)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let id = ReceiptId::parse(
        response.headers()[super::super::RECEIPT_HEADER]
            .to_str()
            .unwrap(),
    )
    .unwrap();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    let stored = state.db.get_receipt(&id).await.unwrap().unwrap();
    let opening = state
        .broker
        .signer
        .open_receipt_intent(&stored.receipt)
        .unwrap();
    for (name, value) in &headers {
        assert!(!name.as_str().contains("intent-opening"));
        assert!(!value.to_str().unwrap_or("").contains(&opening));
    }
    assert!(!std::str::from_utf8(&bytes).unwrap().contains(&opening));
    assert!(!serde_json::to_string(&stored.receipt)
        .unwrap()
        .contains(&opening));
}
