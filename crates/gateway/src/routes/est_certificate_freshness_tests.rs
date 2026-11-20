//! Every EST certificate branch shares the current live-generation fence.
use super::{
    attested, config, install_trust, request, sealed_state, seed_inventory,
    seed_self_signed_profile,
};
use crate::app_state::test_env;
use axum::http::StatusCode;
use opensesame_domain::transport::{TransportError, TransportPolicy};
use opensesame_transport_security::testkit::DisposableCa;

#[tokio::test]
async fn default_bootstrap_trust_still_requires_current_live_evidence() {
    let _guard = test_env::lock();
    let mut state = sealed_state().await;
    let profile = seed_self_signed_profile(&state, "random-value-16b").await;
    let mut config = config(&state, &profile).await;
    config.require_bootstrap = true;
    assert!(config.bootstrap_chain_pem.is_none());
    assert!(state.db.update_est_config(&config).await.unwrap());
    let roots = String::from_utf8(DisposableCa::new("bootstrap").root_pem()).unwrap();
    install_trust(&mut state, &roots);
    let direct = attested(TransportPolicy::MtlsRequired)
        .into_verified()
        .unwrap();
    let mut mismatch = attested(TransportPolicy::MtlsRequired);
    mismatch.trust_generation = 2;
    let mismatch = mismatch.into_verified().unwrap();
    for endpoint in ["simpleenroll", "simplereenroll"] {
        assert_eq!(
            request(&state, &profile, endpoint, Some(&direct), None, None).await,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            request(&state, &profile, endpoint, Some(&mismatch), None, None).await,
            StatusCode::UNAUTHORIZED
        );
    }
    state
        .transport
        .as_ref()
        .unwrap()
        .generations
        .withdraw(TransportError::GenerationStale);
    for endpoint in ["simpleenroll", "simplereenroll"] {
        assert_eq!(
            request(&state, &profile, endpoint, Some(&direct), None, None).await,
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn active_inventory_cannot_bypass_current_live_evidence() {
    let _guard = test_env::lock();
    let mut state = sealed_state().await;
    let profile = seed_self_signed_profile(&state, "random-value-16b").await;
    let mut config = config(&state, &profile).await;
    config.require_bootstrap = true;
    config.bootstrap_chain_pem =
        Some(String::from_utf8(DisposableCa::new("other").root_pem()).unwrap());
    assert!(state.db.update_est_config(&config).await.unwrap());
    seed_inventory(&state).await;
    let roots = String::from_utf8(DisposableCa::new("clients").root_pem()).unwrap();
    install_trust(&mut state, &roots);
    let direct = attested(TransportPolicy::MtlsRequired)
        .into_verified()
        .unwrap();
    assert_eq!(
        request(
            &state,
            &profile,
            "simplereenroll",
            Some(&direct),
            None,
            None
        )
        .await,
        StatusCode::BAD_REQUEST
    );
    let mut mismatch = attested(TransportPolicy::MtlsRequired);
    mismatch.credential_generation = 2;
    let mismatch = mismatch.into_verified().unwrap();
    assert_eq!(
        request(
            &state,
            &profile,
            "simplereenroll",
            Some(&mismatch),
            None,
            None
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
    state
        .transport
        .as_ref()
        .unwrap()
        .generations
        .withdraw(TransportError::GenerationStale);
    assert_eq!(
        request(
            &state,
            &profile,
            "simplereenroll",
            Some(&direct),
            None,
            None
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn certificate_inventory_rotation_after_await_refuses_the_original_peer() {
    let _guard = test_env::lock();
    let mut state = sealed_state().await;
    let profile = seed_self_signed_profile(&state, "random-value-16b").await;
    let mut config = config(&state, &profile).await;
    config.require_bootstrap = true;
    config.bootstrap_chain_pem =
        Some(String::from_utf8(DisposableCa::new("other").root_pem()).unwrap());
    state.db.update_est_config(&config).await.unwrap();
    seed_inventory(&state).await;
    let roots = String::from_utf8(DisposableCa::new("clients").root_pem()).unwrap();
    install_trust(&mut state, &roots);
    let peer = attested(TransportPolicy::MtlsRequired)
        .into_verified()
        .unwrap();
    let (reached, resume) =
        crate::routes::est_wire::test_pause::install(&config.organization_id, "inventory");
    let task_state = state.clone();
    let task_profile = profile.clone();
    let task = tokio::spawn(async move {
        request(
            &task_state,
            &task_profile,
            "simplereenroll",
            Some(&peer),
            None,
            None,
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), reached)
        .await
        .unwrap()
        .unwrap();
    let generations = &state.transport.as_ref().unwrap().generations;
    let current = generations.current();
    generations
        .activate(opensesame_transport_security::GenerationCandidate {
            identity: current.identity.clone(),
            peer_trust: current.peer_trust.clone(),
            ..Default::default()
        })
        .unwrap();
    resume.send(()).unwrap();
    assert_eq!(task.await.unwrap(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn password_budget_rotation_after_await_refuses_old_tls_provenance() {
    use axum::{body::Body, extract::ConnectInfo, http::Request};
    use opensesame_transport_security::ListenerProvenance;
    use tower::ServiceExt;
    let _guard = test_env::lock();
    let mut state = sealed_state().await;
    let profile = seed_self_signed_profile(&state, "random-value-16b").await;
    let config = config(&state, &profile).await;
    let roots = String::from_utf8(DisposableCa::new("clients").root_pem()).unwrap();
    install_trust(&mut state, &roots);
    let mut req = Request::post(format!("/.well-known/est/{profile}/simpleenroll"))
        .header(
            axum::http::header::AUTHORIZATION,
            super::basic("est", "random-value-16b"),
        )
        .body(Body::from("not a csr"))
        .unwrap();
    req.extensions_mut().insert(ListenerProvenance::Tls {
        listener_id: "host".into(),
        policy: TransportPolicy::ServerTls,
        generation: 1,
    });
    req.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
    ));
    let (reached, resume) =
        crate::routes::est_wire::test_pause::install(&config.organization_id, "password");
    let app = super::router(state.clone());
    let task = tokio::spawn(async move { app.oneshot(req).await.unwrap().status() });
    tokio::time::timeout(std::time::Duration::from_secs(5), reached)
        .await
        .unwrap()
        .unwrap();
    let generations = &state.transport.as_ref().unwrap().generations;
    let current = generations.current();
    generations
        .activate(opensesame_transport_security::GenerationCandidate {
            identity: current.identity.clone(),
            peer_trust: current.peer_trust.clone(),
            ..Default::default()
        })
        .unwrap();
    resume.send(()).unwrap();
    assert_eq!(task.await.unwrap(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn est_password_path_fails_closed_without_tls_listener_provenance() {
    let _guard = test_env::lock();
    let mut state = sealed_state().await;
    let roots = String::from_utf8(DisposableCa::new("clients").root_pem()).unwrap();
    install_trust(&mut state, &roots);
    assert!(state.transport.is_some());
    let generations = &state.transport.as_ref().unwrap().generations;
    generations
        .activate(opensesame_transport_security::GenerationCandidate {
            identity: generations.current().identity.clone(),
            peer_trust: generations.current().peer_trust.clone(),
            ..Default::default()
        })
        .unwrap();
    assert!(
        !crate::routes::est_freshness::transport_is_current(
            &state,
            &axum::http::Extensions::new(),
        ),
        "missing ListenerProvenance must not pass the live-generation fence",
    );
}
