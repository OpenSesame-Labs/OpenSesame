//! Receipt retries must bind the current request and its authority.

use super::*;
use opensesame_storage::invocations::IdempotencyFingerprint;

fn input(intent: &Intent, grant: &Grant, parameters: &serde_json::Value) -> InvokeInput {
    InvokeInput {
        intent: intent.clone(),
        grant: grant.clone(),
        subject: "user:demo".into(),
        connection_policy_id: "demo-conn".into(),
        parameters: parameters.clone(),
        lineage: None,
    }
}

#[tokio::test]
async fn changed_request_or_authority_cannot_reuse_the_receipt() {
    let (broker, org, principal, actor) = setup().await;
    let grant = sample_grant(org, principal);
    let parameters = json!({"title": "original"});
    let intent = sample_intent(
        org,
        principal,
        actor,
        "pull_request.create",
        "bound",
        &parameters,
    );
    let first = broker
        .invoke(input(&intent, &grant, &parameters))
        .await
        .unwrap();
    assert_eq!(first.outcome, ReceiptOutcome::Succeeded);
    let raw_digest = intent.digest().unwrap();
    assert_ne!(first.intent_digest, raw_digest);
    assert_eq!(
        first.intent_digest,
        broker
            .signer
            .intent_commitment(&first.invocation_id, &raw_digest)
            .unwrap()
    );
    broker.signer.verify_receipt(&first).unwrap();
    let opening = broker.signer.open_receipt_intent(&first).unwrap();
    assert!(first.verifies_intent_opening(&opening, &raw_digest));
    let other_digest = format!("sha256:{}", "0".repeat(64));
    assert!(!first.verifies_intent_opening(&opening, &other_digest));
    let other_opening = format!("hmac-sha256:v1:{}", "0".repeat(64));
    assert!(!first.verifies_intent_opening(&other_opening, &raw_digest));
    let mut tampered_receipt = first.clone();
    tampered_receipt.operation = "forged-operation".into();
    assert!(tampered_receipt.verifies_intent_opening(&opening, &raw_digest));
    assert!(broker.signer.verify_receipt(&tampered_receipt).is_err());
    assert!(broker
        .signer
        .open_receipt_intent(&tampered_receipt)
        .is_err());

    type Change = (&'static str, fn(&mut InvokeInput));
    let changes: &[Change] = &[
        ("principal", |v| v.intent.principal_id = PrincipalId::new()),
        ("actor", |v| v.intent.actor_id = ActorId::new()),
        ("project", |v| v.intent.project_id = Some(ProjectId::new())),
        ("connection", |v| {
            v.intent.connection_id = Some(ConnectionId::new())
        }),
        ("connection policy", |v| {
            v.connection_policy_id = "other".into()
        }),
        ("subject", |v| v.subject = "user:other".into()),
        ("grant", |v| v.grant.id = GrantId::new()),
        ("grant constraints", |v| {
            v.grant.constraints.budgets.insert("uses".into(), 1);
        }),
        ("operation", |v| {
            v.intent.operation = "repository.read".into()
        }),
        ("resource", |v| v.intent.resource = "repo:acme/other".into()),
        ("audience", |v| {
            v.intent.audience = "https://other.example".into()
        }),
        ("body", |v| v.intent.body_hash = Some("sha256:other".into())),
        ("proof key", |v| {
            v.intent.proof.key_thumbprint = "other".into()
        }),
        ("parent invocation", |v| {
            v.intent.parent_invocation_id = Some(InvocationId::new())
        }),
        ("delegation chain", |v| {
            v.intent.delegation_chain.push(GrantId::new())
        }),
        ("parameters", |v| {
            v.parameters = json!({"title": "different"});
            v.intent.normalized_parameters_hash = Intent::parameters_hash(&v.parameters).unwrap();
        }),
    ];
    for (label, change) in changes {
        let mut retry = input(&intent, &grant, &parameters);
        change(&mut retry);
        assert!(
            broker.invoke(retry).await.is_err(),
            "{label} reused an unrelated receipt"
        );
    }
    let mut changed_lineage = input(&intent, &grant, &parameters);
    changed_lineage.lineage = Some(
        ValidatedGrantChain::try_validate(std::slice::from_ref(&grant), Utc::now(), 0).unwrap(),
    );
    let error = broker.invoke(changed_lineage).await.unwrap_err();
    assert!(error.to_string().contains("different or missing binding"));
    let mut forged = input(&intent, &grant, &parameters);
    forged.parameters = json!({"title": "different"});
    let error = broker.invoke(forged).await.unwrap_err();
    assert!(error.to_string().contains("parameter digest"));
    assert_eq!(broker.db.count_receipts().await.unwrap(), 1);
}

#[tokio::test]
async fn current_policy_is_rechecked_before_returning_a_prior_receipt() {
    let (mut broker, org, principal, actor) = setup().await;
    let grant = sample_grant(org, principal);
    let parameters = json!({});
    let intent = sample_intent(
        org,
        principal,
        actor,
        "repository.read",
        "policy",
        &parameters,
    );
    assert_eq!(
        broker
            .invoke(input(&intent, &grant, &parameters))
            .await
            .unwrap()
            .outcome,
        ReceiptOutcome::Succeeded
    );
    broker.policy.relationships = Default::default();
    let error = broker
        .invoke(input(&intent, &grant, &parameters))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("current authorization denied"));
}

#[tokio::test]
async fn legacy_unbound_rows_are_not_guessed_into_retries() {
    let (broker, org, principal, actor) = setup().await;
    let grant = sample_grant(org, principal);
    let parameters = json!({});
    let intent = sample_intent(org, principal, actor, "repository.read", "old", &parameters);
    broker.db.insert_intent(&intent).await.unwrap();
    let error = broker
        .invoke(input(&intent, &grant, &parameters))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("missing binding"));
}

#[tokio::test]
async fn concurrent_reservations_atomically_keep_the_winners_fingerprint() {
    let path = std::env::temp_dir().join(format!(
        "opensesame-idempotency-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let url = format!("sqlite://{}?mode=rwc", path.display());
    let db = Db::connect_sqlite(&url).await.unwrap();
    let org = OrganizationId::new();
    db.create_organization(&org, "concurrency").await.unwrap();
    let principal = PrincipalId::new();
    let actor = ActorId::new();
    let params = json!({});
    let first = sample_intent(org, principal, actor, "repository.read", "race", &params);
    let mut second = first.clone();
    second.id = IntentId::new();
    let first_binding = IdempotencyFingerprint::from_request(&json!({"request": "first"})).unwrap();
    let second_binding =
        IdempotencyFingerprint::from_request(&json!({"request": "second"})).unwrap();
    let (a, b) = tokio::join!(
        db.insert_bound_intent(&first, &first_binding),
        db.insert_bound_intent(&second, &second_binding),
    );
    assert_ne!(a.is_ok(), b.is_ok(), "exactly one request reserves the key");
    let stored = db
        .find_idempotent_intent(&org, "race")
        .await
        .unwrap()
        .unwrap();
    let (winner, fingerprint) = if a.is_ok() {
        (&first, first_binding)
    } else {
        (&second, second_binding)
    };
    assert_eq!(stored.intent.id, winner.id);
    assert_eq!(stored.fingerprint, Some(fingerprint));
    assert_eq!(
        db.find_intent_by_idempotency(&org, "race")
            .await
            .unwrap()
            .unwrap()
            .id,
        winner.id
    );
    db.pool().close().await;
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn legacy_raw_intent_digest_cannot_replay_or_start_another_effect() {
    let (broker, org, principal, actor) = setup().await;
    let grant = sample_grant(org, principal);
    let parameters = json!({"private_choice": "small-domain"});
    let mut intent = sample_intent(
        org,
        principal,
        actor,
        "repository.read",
        "raw-digest",
        &parameters,
    );
    // Public broker callers can provide a predictable nonce. Receipt secrecy
    // must not depend on the gateway's random-nonce behavior.
    intent.nonce = "known-nonce".into();
    let raw_digest = intent.digest().unwrap();
    let receipt = broker
        .invoke(input(&intent, &grant, &parameters))
        .await
        .unwrap();
    assert_ne!(receipt.intent_digest, raw_digest);
    assert_eq!(
        receipt.intent_digest,
        broker
            .signer
            .intent_commitment(&receipt.invocation_id, &raw_digest)
            .unwrap()
    );
    sqlx::query("DELETE FROM receipts WHERE id = ?")
        .bind(receipt.id.to_string())
        .execute(broker.db.pool())
        .await
        .unwrap();
    let mut legacy = receipt;
    legacy.receipt_schema_version = 5;
    legacy.intent_digest = raw_digest;
    let legacy = broker.signer.sign_receipt(legacy).unwrap();
    broker.signer.verify_receipt(&legacy).unwrap();
    broker.db.insert_receipt(&legacy).await.unwrap();
    assert!(broker
        .replay(input(&intent, &grant, &parameters))
        .await
        .is_err());
    assert!(broker
        .invoke(input(&intent, &grant, &parameters))
        .await
        .is_err());
    assert_eq!(
        broker
            .db
            .count_invocations_for_intent(&intent.id)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn receipt_signing_key_rotation_refuses_replay_without_reexecution() {
    let (mut broker, org, principal, actor) = setup().await;
    broker.signer = opensesame_audit::ReceiptSigner::from_seed(&[41; 32]);
    let params = json!({});
    let intent = sample_intent(
        org,
        principal,
        actor,
        "repository.read",
        "key-rotation",
        &params,
    );
    let grant = sample_grant(org, principal);
    let input = || InvokeInput {
        intent: intent.clone(),
        grant: grant.clone(),
        subject: "user:demo".into(),
        connection_policy_id: "demo-conn".into(),
        parameters: params.clone(),
        lineage: None,
    };
    let receipt = broker.invoke(input()).await.unwrap();
    let raw_digest = intent.digest().unwrap();
    let opening = broker.signer.open_receipt_intent(&receipt).unwrap();
    assert!(receipt.verifies_intent_opening(&opening, &raw_digest));
    let mut verifier = opensesame_audit::ReceiptVerifier::new();
    verifier.trust(broker.signer.verifying_key());
    broker.signer = opensesame_audit::ReceiptSigner::from_seed(&[42; 32]);
    assert!(broker.signer.open_receipt_intent(&receipt).is_err());
    verifier.verify(&receipt).unwrap();
    assert!(receipt.verifies_intent_opening(&opening, &raw_digest));
    assert_ne!(receipt.authority_key_id, broker.signer.key_id);
    assert!(broker.replay(input()).await.is_err());
    assert!(broker.invoke(input()).await.is_err());
    assert_eq!(
        broker
            .db
            .count_invocations_for_intent(&intent.id)
            .await
            .unwrap(),
        1
    );
}
