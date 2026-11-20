//! Council P5 regressions: block shadows, branch URLs, closure guards, SQLx lets.
use super::sync_target_pact_chain::dispatch_alias_calls;
use super::sync_target_pact_p5::{assert_clear, assert_gaps, assert_read};

#[test]
fn p5_council_block_shadow_keeps_outer_dispatch_alias() {
    let live = [
        "fn f() { let dispatch = Path::send; { let dispatch = other; } dispatch(request); }",
        "fn f() { let dispatch = Path::send; let (n /* dispatch */, ) = (1,); dispatch(request); }",
        "fn f() { let dispatch = Path::send; let (/* dispatch */ n,) = (1,); dispatch(request); }",
        "fn f() { let dispatch = Path::send; let (dispatch_name,) = (1,); dispatch(request); }",
    ];
    for sample in live {
        assert_eq!(dispatch_alias_calls(sample).len(), 1, "{sample}");
    }
    let dead = [
        "fn f() { let dispatch = Path::send; { let dispatch = other; dispatch(request); } }",
        "fn f() { let dispatch = Path::send; let (dispatch,) = (other,); dispatch(request); }",
        "fn f() { let dispatch = Path::send; dispatch = other; dispatch(request); }",
    ];
    for sample in dead {
        assert!(dispatch_alias_calls(sample).is_empty(), "{sample}");
    }
    let outer = r#"async fn f() { let dispatch = reqwest::RequestBuilder::send; { let dispatch = other; } dispatch(request).await?; }"#;
    assert_gaps(outer, (1, 1));
}

#[test]
fn p5_council_builder_url_is_scope_and_branch_aware() {
    let gaps = [
        (
            r#"async fn f() { let request = client.get(evil); { let request = client.get(url); } if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#,
            (1, 1),
        ),
        (
            r#"async fn f() { let request = client.get(url); { let request = client.get(evil); } if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#,
            (1, 0),
        ),
        (
            r#"async fn f() { let mut request = client.get(evil); if cond { request = client.get(url); } if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#,
            (1, 1),
        ),
        (
            r#"async fn f() { let mut request = client.get(evil); if cond { request = client.get(url); } else { request = client.get(url); } if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#,
            (1, 0),
        ),
        (
            r#"async fn f() { let mut request = client.get(url); if cond { request = client.get(evil); } else { request = client.get(url); } if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#,
            (1, 1),
        ),
    ];
    for (sample, expected) in gaps {
        assert_gaps(sample, expected);
    }
}

#[test]
fn p5_council_logic_op_closure_is_not_an_https_guard() {
    let gaps = [
        (
            r#"async fn f() { if parsed.scheme() != "https" { flag || |x| return Err("x".into()); } request.send().await?; }"#,
            (1, 1),
        ),
        (
            r#"async fn f() { if parsed.scheme() != "https" { flag && |x| return Err("x".into()); } request.send().await?; }"#,
            (1, 1),
        ),
        (
            r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } client.get(url).send().await?; }"#,
            (1, 0),
        ),
        (
            r#"async fn f() { if config.url.scheme() != "https" { return Err("x".into()); } client.get(url).send().await?; }"#,
            (1, 1),
        ),
        (
            r#"async fn f() { if (url).scheme() != "https" { return Err("x".into()); } client.get(&url).send().await?; }"#,
            (1, 0),
        ),
    ];
    for (sample, expected) in gaps {
        assert_gaps(sample, expected);
    }
}

#[test]
fn p5_council_sqlx_let_is_scoped_to_a_real_callee() {
    let gaps = [
        (
            r#"fn db() { let query = sqlx::query("select 1"); } async fn f() { let query = client; query.execute(request).await?; }"#,
            (1, 1),
        ),
        (
            r#"async fn f() { let query = client; { let query = sqlx::query("select 1"); } query.execute(request).await?; }"#,
            (1, 1),
        ),
        (
            r#"async fn f() { let query = not_sqlx::query("x"); query.execute(request).await?; }"#,
            (1, 1),
        ),
        (
            r#"async fn f() { let query = "sqlx::query"; query.execute(request).await?; }"#,
            (1, 1),
        ),
        (
            r#"async fn f() { let query = sqlx::query("select 1"); query.execute(&pool).await?; }"#,
            (0, 0),
        ),
        (
            r#"async fn f() { let query = sqlx::Query::new(); query.execute(&pool).await?; }"#,
            (0, 0),
        ),
    ];
    for (sample, expected) in gaps {
        assert_gaps(sample, expected);
    }
}

#[test]
fn p5_council_tuple_and_tmp_shadow_track_the_response() {
    for sample in [
        "let (reply,) = (response,); reply.into()",
        "let ((reply,),) = ((response,),); reply.into()",
        "let (mut reply,) = (response,); reply.into()",
        "let tmp = response; let reply = tmp; let tmp = status; reply.into()",
        "let tmp = response; { let tmp = status; } let reply = tmp; reply.into()",
        "helper::<T>(&response)",
        "helper::<T>(&mut response)",
        "helper::<Vec<T>>(&response)",
        "drop::<T>(&response)",
    ] {
        assert_read(sample);
    }
    for sample in [
        "let (reply,) = (status,); reply.into()",
        "let tmp = status; let reply = tmp; let tmp = response; reply.into()",
        "reqwest::RequestBuilder::json::<serde_json::Value>(request, &body)",
    ] {
        assert_clear(sample);
    }
}
