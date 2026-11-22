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
