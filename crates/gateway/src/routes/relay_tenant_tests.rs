//! Pre-existing requests retain scoped inspection and denial.

use super::*;

#[tokio::test]
async fn legacy_requests_can_be_inspected_and_denied_only_by_their_tenant() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let other_org = OrganizationId::new();
    let delegation = relay_delegation(&state, org, ExecutionMode::Relay).await;
    let holder =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    let delegate =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let other_holder =
        crate::app_state::test_session_headers(&state, OWNER, other_org, OrganizationRole::Member);
    let other_delegate =
        crate::app_state::test_session_headers(&state, GUEST, other_org, OrganizationRole::Member);
    let (id, _) = seed_request(&state, org, &delegation, "pending_approval").await;

    for headers in [&other_holder, &other_delegate] {
        assert_eq!(
            get(State(state.clone()), headers.clone(), Path(id.clone()))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        deny(State(state.clone()), other_holder, Path(id.clone()))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );

    let details =
        body_json(get(State(state.clone()), delegate.clone(), Path(id.clone())).await).await;
    assert_eq!(
        details,
        json!({"id":id,"state":"pending_approval","outcome":null})
    );
    assert_eq!(
        deny(State(state.clone()), holder, Path(id.clone()))
            .await
            .status(),
        StatusCode::OK
    );
    let denied = body_json(get(State(state), delegate, Path(id)).await).await;
    assert_eq!(denied["state"], "denied");
}

#[tokio::test]
async fn legacy_read_never_discloses_executable_fields_or_holder_summary() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let delegation = relay_delegation(&state, org, ExecutionMode::Relay).await;
    let holder =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    let delegate =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let (id, _) = seed_request(&state, org, &delegation, "completed").await;
    sqlx::query("UPDATE relay_requests SET operation = ?, resource = ?, request_digest = ?, result_json = ?, result_outcome = ? WHERE id = ?")
        .bind("operation-sentinel")
        .bind("resource-sentinel")
        .bind("digest-sentinel")
        .bind(r#"{"note":"cmVsYXktc2VudGluZWw="}"#)
        .bind("succeeded")
        .bind(&id)
        .execute(state.connection_broker.pool()).await.unwrap();
    for headers in [holder, delegate] {
        let response = get(State(state.clone()), headers, Path(id.clone())).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({"id": id, "state":"completed", "outcome":"succeeded"})
        );
    }
}

#[tokio::test]
async fn legacy_reports_are_refused_without_disclosing_or_mutating_the_row() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let other_org = OrganizationId::new();
    let delegation = relay_delegation(&state, org, ExecutionMode::Relay).await;
    let holder =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    let other_holder =
        crate::app_state::test_session_headers(&state, OWNER, other_org, OrganizationRole::Member);
    let (id, _) = seed_request(&state, org, &delegation, "approved").await;
    for headers in [holder, other_holder] {
        let response = result(State(state.clone()), headers, Path(id.clone())).await;
        assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
        assert_eq!(
            body_json(response).await,
            json!({"error":"relay_execution_unavailable"})
        );
    }
    let (stored_state, stored_result): (String, Option<String>) =
        sqlx::query_as("SELECT state, result_json FROM relay_requests WHERE id = ?")
            .bind(&id)
            .fetch_one(state.connection_broker.pool())
            .await
            .unwrap();
    assert_eq!(stored_state, "approved");
    assert_eq!(stored_result, None);
}

const STRANGER: &str = "principal:00000000-0000-4000-8000-000000000017";

fn formal_vectors(family: &str) -> Vec<Vec<String>> {
    let path = std::env::var("OPENSESAME_HOST_CLI_VECTORS").expect("run the host-cli verifier");
    let text = std::fs::read_to_string(path).expect("read formal vectors");
    text.lines()
        .map(|line| line.split('\t').map(str::to_owned).collect::<Vec<_>>())
        .filter(|fields| fields[0] == family)
        .map(|fields| fields[1..].to_vec())
        .collect()
}

const STATES: [(&str, &str); 6] = [
    ("pendingApproval", "pending_approval"),
    ("approved", "approved"),
    ("denied", "denied"),
    ("completed", "completed"),
    ("failed", "failed"),
    ("bogus", "bogus"),
];

fn stored(name: &str) -> &'static str {
    let key = name.strip_prefix("Stored.").expect("stored state");
    STATES
        .iter()
        .find(|(model, _)| *model == key)
        .expect("state")
        .1
}

fn model_state(raw: &str) -> String {
    let found = STATES
        .iter()
        .find(|(_, db)| *db == raw)
        .expect("known state");
    format!("Stored.{}", found.0)
}

fn view_name(raw: &Value) -> String {
    let raw = raw.as_str().unwrap_or_default();
    let model = STATES
        .iter()
        .find(|(_, db)| *db == raw)
        .map_or(raw, |(model, _)| model);
    format!("view:View.{model}")
}

struct Tenancy {
    state: AppState,
    org: OrganizationId,
    other_org: OrganizationId,
    operator: String,
    delegation: String,
}

/// Headers for the modeled caller, and the (holder, delegate) subjects of a
/// row that place the caller in its modeled party.
fn caller(t: &Tenancy, name: &str) -> (axum::http::HeaderMap, (String, String)) {
    let parties = [
        ("holder", OWNER),
        ("delegate", GUEST),
        ("stranger", STRANGER),
    ];
    let party = |n: &str| parties.iter().find(|(p, _)| n.contains(p)).expect("party");
    let mut rows = (OWNER.to_owned(), GUEST.to_owned());
    let headers = if let Some(rest) = name.strip_prefix("Caller.session ") {
        let org = if rest.contains("Org.a") {
            t.org
        } else {
            t.other_org
        };
        let subject = party(rest).1;
        crate::app_state::test_session_headers(&t.state, subject, org, OrganizationRole::Member)
    } else if let Some(rest) = name.strip_prefix("Caller.operator ") {
        match party(rest).0 {
            "holder" => rows.0.clone_from(&t.operator),
            "delegate" => rows.1.clone_from(&t.operator),
            _ => {}
        }
        let mut headers = axum::http::HeaderMap::new();
        let value = format!("Bearer operator:{}", t.state.operator_token);
        headers.insert(axum::http::header::AUTHORIZATION, value.parse().unwrap());
        headers
    } else {
        assert_eq!(name, "Caller.anonymous");
        axum::http::HeaderMap::new()
    };
    (headers, rows)
}

async fn seed_formal_row(t: &Tenancy, f: &[String], parties: &(String, String)) -> String {
    let id = format!("rreq_{}", uuid::Uuid::now_v7().simple());
    let org = if f[2] == "Org.a" { t.org } else { t.other_org };
    let offset = opensesame_time::Duration::minutes(if bit(&f[4]) { -2 } else { 2 });
    sqlx::query(
        "INSERT INTO relay_requests
         (id, delegation_id, connection_id, organization_id, holder_subject, delegate_subject,
          operation, resource, parameters_json, request_digest, state, expires_at, created_at)
         VALUES (?, ?, 'connection', ?, ?, ?, 'repository.read', 'repo:acme/catalog',
                 '{\"private_parameter\":\"relay-sentinel\"}', 'sha256:0', ?, ?, ?)",
    )
    .bind(&id)
    .bind(&t.delegation)
    .bind(org.to_string())
    .bind(&parties.0)
    .bind(&parties.1)
    .bind(stored(&f[3]))
    .bind((Utc::now() + offset).to_rfc3339())
    .bind(Utc::now().to_rfc3339())
    .execute(t.state.connection_broker.pool())
    .await
    .unwrap();
    id
}

fn bit(value: &str) -> bool {
    match value {
        "0" => false,
        "1" => true,
        _ => panic!("invalid formal bit {value}"),
    }
}

async fn call(t: &Tenancy, route: &str, headers: axum::http::HeaderMap, id: &str) -> Response {
    let (st, id) = (State(t.state.clone()), Path(id.to_owned()));
    match route {
        "Route.heartbeat" => heartbeat(st, headers).await,
        "Route.submit" => submit(st, headers).await,
        "Route.pending" => pending(st, headers).await,
        "Route.approve" => approve(st, headers, id).await,
        "Route.deny" => deny(st, headers, id).await,
        "Route.result" => result(st, headers, id).await,
        "Route.get" => get(st, headers, id).await,
        other => panic!("invalid route {other}"),
    }
}

/// Only the three non-executable fields may ever be disclosed.
async fn reply(route: &str, id: &str, response: Response) -> String {
    let status = response.status().as_u16();
    let body = body_json(response).await;
    let exact_view = body.as_object().is_some_and(|o| o.len() == 3)
        && body["id"] == json!(id)
        && body["outcome"].is_null();
    match (status, route) {
        (401, _) if body["error"] == "operator_unauthorized" => "Reply.unauthorized".into(),
        (404, _) if body == json!({"error": "not_found"}) => "Reply.notFound".into(),
        (501, _) if body == json!({"error": "relay_execution_unavailable"}) => {
            "Reply.unavailable".into()
        }
        (200, "Route.deny") if body == json!({"id": id, "state": "denied"}) => {
            "Reply.deniedOk".into()
        }
        (200, "Route.get") if exact_view => view_name(&body["state"]),
        _ => format!("other:{status}:{body}"),
    }
}

#[tokio::test]
#[ignore = "requires Lean vectors; run spec/formal/host-cli/verify.sh"]
async fn lean_relay_vectors_match_the_relay_routes() {
    let state = crate::app_state::test_demo_state().await;
    let boot = state.bootstrap.lock().unwrap().as_ref().unwrap().clone();
    let delegation = relay_delegation(&state, boot.org, ExecutionMode::Relay).await;
    let operator = boot.principal.to_string();
    assert!(![OWNER, GUEST, STRANGER].contains(&operator.as_str()));
    let t = Tenancy {
        state,
        org: boot.org,
        other_org: OrganizationId::new(),
        operator,
        delegation,
    };
    let cases = formal_vectors("relay");
    for f in &cases {
        let (headers, parties) = caller(&t, &f[0]);
        let id = seed_formal_row(&t, f, &parties).await;
        let answer = reply(&f[1], &id, call(&t, &f[1], headers, &id).await).await;
        let after: String = sqlx::query_scalar("SELECT state FROM relay_requests WHERE id = ?")
            .bind(&id)
            .fetch_one(t.state.connection_broker.pool())
            .await
            .unwrap();
        let actual = format!("{answer}\t{}", model_state(&after));
        let expected = format!("{}\t{}", f[5], f[6]);
        assert_eq!(
            actual,
            expected,
            "decision mismatch for relay {}",
            f.join(" ")
        );
    }
    assert_eq!(cases.len(), 1512, "incomplete relay vectors");
}
