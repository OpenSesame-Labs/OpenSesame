use super::*;
use opensesame_domain::{
    ActorId, DetachedProof, Intent, IntentId, InvocationId, OrganizationId, PrincipalId, ReceiptId,
};
use opensesame_time::{Duration, Utc};
use serde_json::json;

fn evidence(
    organization: OrganizationId,
    state: InvocationState,
    outcome: ReceiptOutcome,
) -> (Intent, Invocation, InvocationReceipt) {
    let now = Utc::now();
    let intent = Intent {
        id: IntentId::new(),
        organization_id: organization,
        project_id: None,
        principal_id: PrincipalId::new(),
        actor_id: ActorId::new(),
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: None,
        operation: "read".into(),
        resource: "doc:1".into(),
        audience: "https://resource.example".into(),
        normalized_parameters_hash: Intent::parameters_hash(&json!({})).unwrap(),
        body_hash: None,
        nonce: "nonce".into(),
        idempotency_key: uuid::Uuid::new_v4().to_string(),
        issued_at: now,
        expires_at: now + Duration::minutes(5),
        parent_invocation_id: None,
        delegation_chain: vec![],
        proof: DetachedProof {
            algorithm: "test".into(),
            key_thumbprint: "test".into(),
            signature: "test".into(),
        },
    };
    let invocation = Invocation {
        id: InvocationId::new(),
        intent_id: intent.id,
        state,
        attempt: 1,
        lease_owner: Some("worker-local".into()),
        lease_expires_at: None,
        created_at: now,
        updated_at: now,
    };
    let receipt = InvocationReceipt {
        id: ReceiptId::new(),
        invocation_id: invocation.id,
        intent_digest: "sha256:intent".into(),
        idempotency_binding: None,
        principal_id: intent.principal_id,
        organization_id: Some(organization),
        actor_id: intent.actor_id,
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        delegation_chain: vec![],
        connection_id: None,
        operation: intent.operation.clone(),
        resource: intent.resource.clone(),
        policy_decision_id: "decision".into(),
        policy_version_digest: "sha256:policy".into(),
        approval_id: None,
        credential_handle_id: None,
        connector_component_digest: None,
        external_request_digest: None,
        external_response_digest: None,
        started_at: now,
        completed_at: now,
        outcome,
        safe_result_summary: Some(json!({"ok": true})),
        authority_key_id: "test".into(),
        signature: "signature".into(),
        receipt_schema_version: 3,
        task_run_id: None,
        task_state_version: None,
        task_state_digest: None,
    };
    (intent, invocation, receipt)
}

async fn setup() -> (Db, OrganizationId) {
    let db = Db::connect_memory().await.unwrap();
    let organization = OrganizationId::new();
    db.create_organization(&organization, "atomic-outcome")
        .await
        .unwrap();
    (db, organization)
}

async fn stored_invocation(db: &Db, organization: OrganizationId, id: InvocationId) -> Invocation {
    let row = sqlx::query("SELECT state, body_json FROM invocations WHERE id = ?")
        .bind(id.to_string())
        .fetch_one(db.pool())
        .await
        .unwrap();
    let body = sealed::open_in(
        &organization.to_string(),
        "invocations.body_json",
        &id.to_string(),
        &row.get::<String, _>("body_json"),
    )
    .unwrap();
    let invocation: Invocation = serde_json::from_str(&body).unwrap();
    assert_eq!(
        row.get::<String, _>("state"),
        format!("{:?}", invocation.state).to_lowercase()
    );
    invocation
}

async fn reject_receipt_inserts(db: &Db) {
    sqlx::query(
        "CREATE TRIGGER test_reject_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    )
    .execute(db.pool())
    .await
    .unwrap();
}

#[tokio::test]
async fn terminal_state_and_receipt_commit_once_together() {
    for (state, outcome) in [
        (InvocationState::Succeeded, ReceiptOutcome::Succeeded),
        (InvocationState::Failed, ReceiptOutcome::Failed),
    ] {
        let (db, organization) = setup().await;
        let (intent, executing, receipt) =
            evidence(organization, InvocationState::Executing, outcome);
        db.insert_intent(&intent).await.unwrap();
        db.insert_invocation(&executing).await.unwrap();
        let mut terminal = executing.clone();
        terminal.transition(state, Utc::now()).unwrap();

        db.finish_executing_invocation(&terminal, &receipt)
            .await
            .unwrap();
        assert_eq!(
            stored_invocation(&db, organization, terminal.id).await,
            terminal
        );
        assert_eq!(
            db.get_receipt(&receipt.id).await.unwrap().unwrap().receipt,
            receipt
        );
        assert!(db
            .finish_executing_invocation(&terminal, &receipt)
            .await
            .is_err());
        assert_eq!(db.count_receipts().await.unwrap(), 1);
    }
}

#[tokio::test]
async fn opaque_indeterminate_receipt_preserves_the_private_terminal_state() {
    for state in [InvocationState::Succeeded, InvocationState::Failed] {
        let (db, organization) = setup().await;
        let (intent, executing, mut receipt) = evidence(
            organization,
            InvocationState::Executing,
            ReceiptOutcome::Indeterminate,
        );
        receipt.receipt_schema_version = opensesame_domain::OPAQUE_RESULT_RECEIPT_SCHEMA_VERSION;
        receipt.intent_digest = format!("sha256:{}", "a".repeat(64));
        receipt.safe_result_summary = None;
        db.insert_intent(&intent).await.unwrap();
        db.insert_invocation(&executing).await.unwrap();
        let mut terminal = executing.clone();
        terminal.transition(state, Utc::now()).unwrap();
        db.finish_executing_invocation(&terminal, &receipt)
            .await
            .unwrap();
        assert_eq!(
            stored_invocation(&db, organization, terminal.id).await,
            terminal
        );
        assert_eq!(
            db.get_receipt(&receipt.id)
                .await
                .unwrap()
                .unwrap()
                .receipt
                .outcome,
            ReceiptOutcome::Indeterminate
        );
    }
}

#[tokio::test]
async fn failed_receipt_insert_rolls_back_terminal_state() {
    let (db, organization) = setup().await;
    let (intent, executing, receipt) = evidence(
        organization,
        InvocationState::Executing,
        ReceiptOutcome::Succeeded,
    );
    db.insert_intent(&intent).await.unwrap();
    db.insert_invocation(&executing).await.unwrap();
    let mut terminal = executing.clone();
    terminal
        .transition(InvocationState::Succeeded, Utc::now())
        .unwrap();
    reject_receipt_inserts(&db).await;

    assert!(db
        .finish_executing_invocation(&terminal, &receipt)
        .await
        .is_err());
    assert_eq!(
        stored_invocation(&db, organization, executing.id).await,
        executing
    );
    assert_eq!(db.count_receipts().await.unwrap(), 0);
    sqlx::query("DROP TRIGGER test_reject_receipt")
        .execute(db.pool())
        .await
        .unwrap();
    db.finish_executing_invocation(&terminal, &receipt)
        .await
        .unwrap();
    assert_eq!(
        stored_invocation(&db, organization, terminal.id).await,
        terminal
    );
}

#[tokio::test]
async fn pre_execution_denial_and_receipt_are_atomic() {
    let (db, organization) = setup().await;
    let (intent, denied, receipt) = evidence(
        organization,
        InvocationState::Denied,
        ReceiptOutcome::Denied,
    );
    db.insert_intent(&intent).await.unwrap();
    reject_receipt_inserts(&db).await;
    assert!(db
        .insert_denied_invocation_with_receipt(&denied, &receipt)
        .await
        .is_err());
    assert_eq!(
        db.count_invocations_for_intent(&intent.id).await.unwrap(),
        0
    );
    assert_eq!(db.count_receipts().await.unwrap(), 0);

    sqlx::query("DROP TRIGGER test_reject_receipt")
        .execute(db.pool())
        .await
        .unwrap();
    db.insert_denied_invocation_with_receipt(&denied, &receipt)
        .await
        .unwrap();
    assert_eq!(
        stored_invocation(&db, organization, denied.id).await,
        denied
    );
    assert_eq!(
        db.get_receipt(&receipt.id).await.unwrap().unwrap().receipt,
        receipt
    );
}

#[tokio::test]
async fn mismatched_receipt_or_changed_invocation_cannot_settle() {
    let (db, organization) = setup().await;
    let (intent, executing, receipt) = evidence(
        organization,
        InvocationState::Executing,
        ReceiptOutcome::Succeeded,
    );
    db.insert_intent(&intent).await.unwrap();
    db.insert_invocation(&executing).await.unwrap();
    let mut terminal = executing.clone();
    terminal
        .transition(InvocationState::Succeeded, Utc::now())
        .unwrap();

    let mut wrong_id = receipt.clone();
    wrong_id.invocation_id = InvocationId::new();
    assert!(db
        .finish_executing_invocation(&terminal, &wrong_id)
        .await
        .is_err());
    let mut wrong_org = receipt.clone();
    wrong_org.organization_id = Some(OrganizationId::new());
    assert!(db
        .finish_executing_invocation(&terminal, &wrong_org)
        .await
        .is_err());
    let mut wrong_outcome = receipt.clone();
    wrong_outcome.outcome = ReceiptOutcome::Failed;
    assert!(db
        .finish_executing_invocation(&terminal, &wrong_outcome)
        .await
        .is_err());
    let mut changed = terminal.clone();
    changed.lease_owner = Some("another-worker".into());
    assert!(db
        .finish_executing_invocation(&changed, &receipt)
        .await
        .is_err());
    assert_eq!(
        stored_invocation(&db, organization, executing.id).await,
        executing
    );
    assert_eq!(db.count_receipts().await.unwrap(), 0);
}
