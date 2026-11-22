use super::*;

#[tokio::test]
async fn a_member_session_cannot_use_the_operators_storage_connection() {
    let st = state_with_broker().await;
    let token = operator(&st);
    let connection = make_connection(&st, "dropbox").await;
    let app = app(st.clone());
    let res = app
        .clone()
        .oneshot(put_target_req(
            &token,
            &json!({"connection_id": connection, "folder_path": "/OpenSesame"}),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let chunk = b"sealed chunk bytes";
    let digest = blake3::hash(chunk).to_hex().to_string();
    let requests = [
        (
            format!("/api/v1/attachments/replicate/chunk?digest={digest}"),
            chunk.as_slice(),
        ),
        (
            "/api/v1/attachments/replicate/manifest?path=Taxes/2025".to_string(),
            b"sealed manifest".as_slice(),
        ),
    ];
    // P26 also owns the connection: ownership and membership alone do not
    // authorize this credential-injecting replication operation. Owner and
    // admin sessions additionally need the exact replication grant; that
    // pair is covered by `attachments/authority.rs`.
    for role in [OrganizationRole::Member] {
        let headers = test_session_headers(
            &st,
            crate::test_principals::P26,
            st.connection_organization,
            role,
        );
        for (uri, body) in &requests {
            let mut request = Request::builder().method("POST").uri(uri);
            for (name, value) in &headers {
                request = request.header(name, value);
            }
            let res = app
                .clone()
                .oneshot(request.body(Body::from(body.to_vec())).unwrap())
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::FORBIDDEN, "{role:?} used {uri}");
        }
    }
    let target = st
        .db
        .get_attachment_target(&st.connection_organization.to_string())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        target.status, "configured",
        "denied requests must not reach the provider"
    );
    assert!(target.last_error.is_none());
}

#[tokio::test]
async fn upload_proof_binds_the_operator_target_operation_path_and_body() {
    let st = state_with_broker().await;
    let token = operator(&st);
    let connection = make_connection(&st, "dropbox").await;
    let res = app(st.clone())
        .oneshot(put_target_req(
            &token,
            &json!({"connection_id": connection, "folder_path": "/OpenSesame"}),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("x-opensesame-operator", token.parse().unwrap());
    let target = st
        .db
        .get_attachment_target(&st.connection_organization.to_string())
        .await
        .unwrap()
        .unwrap();
    headers.insert(
        "x-opensesame-attachment-target",
        target_replication_version(&target).parse().unwrap(),
    );

    let operator = replication_operator(&st, &headers).unwrap();
    let body = Bytes::from_static(b"sealed manifest");
    let validated = ValidatedReplication::manifest("Taxes/2025".into(), body.clone()).unwrap();
    let proof = authorize_upload(&st, operator, validated).await.unwrap();
    let (organization, connection_id, remote_path, sent_body) = proof.observed();
    assert_eq!(organization, st.connection_organization);
    assert_eq!(connection_id, connection);
    assert_eq!(remote_path, "/OpenSesame/manifests/Taxes/2025.osattach");
    assert_eq!(*sent_body, body);

    let bytes = Bytes::from_static(b"sealed chunk");
    let digest = blake3::hash(&bytes).to_hex().to_string();
    let validated = ValidatedReplication::chunk(&digest, bytes.clone()).unwrap();
    let (remote_path, sent_body) = validated.observed("/OpenSesame");
    assert_eq!(
        remote_path,
        format!("/OpenSesame/objects/{}/{digest}.oschunk", &digest[..2])
    );
    assert_eq!(*sent_body, bytes);
}

#[tokio::test]
async fn changed_target_refuses_both_upload_operations_before_provider_use() {
    let st = state_with_broker().await;
    let token = operator(&st);
    let connection = make_connection(&st, "dropbox").await;
    let app = app(st.clone());
    let body = json!({"connection_id": connection, "folder_path": "/old"});
    let initial = app
        .clone()
        .oneshot(put_target_req(&token, &body))
        .await
        .unwrap();
    let version = body_json(initial).await["target"]["replication_version"]
        .as_str()
        .unwrap()
        .to_string();

    // Status/error bookkeeping must not invalidate a target selection.
    st.db
        .record_attachment_target_error(
            &st.connection_organization.to_string(),
            Some("previous error"),
        )
        .await
        .unwrap();
    let current = st
        .db
        .get_attachment_target(&st.connection_organization.to_string())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(version, target_replication_version(&current));

    let changed = json!({"connection_id": connection, "folder_path": "/new"});
    let response = app
        .clone()
        .oneshot(put_target_req(&token, &changed))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let chunk = b"sealed chunk";
    let digest = blake3::hash(chunk).to_hex().to_string();
    for (uri, payload) in [
        (
            format!("/api/v1/attachments/replicate/chunk?digest={digest}"),
            chunk.as_slice(),
        ),
        (
            "/api/v1/attachments/replicate/manifest?path=Taxes/2025".to_string(),
            b"sealed manifest".as_slice(),
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header("x-opensesame-operator", &token)
                    .header("x-opensesame-attachment-target", &version)
                    .body(Body::from(payload.to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(response).await["error"],
            "attachment_target_changed"
        );
    }
    let target = st
        .db
        .get_attachment_target(&st.connection_organization.to_string())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(target.status, "configured");
}
