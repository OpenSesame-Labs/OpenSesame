use crate::tests::sync_target_pact_https::credentialed_send_https_gaps;

#[test]
fn p5_typed_parsed_url_guard_covers_send() {
    let sample = r#"async fn f() { let parsed: Url = Url::parse(&url); if parsed.scheme() != "https" { return Err("x".into()); } client.get(&url).send().await?; }"#;
    assert_eq!(credentialed_send_https_gaps(sample), (1, 0), "{sample}");
    let qualified = r#"async fn f() { let parsed: url::Url = Url::parse(&url); if parsed.scheme() != "https" { return Err("x".into()); } client.get(&url).send().await?; }"#;
    assert_eq!(
        credentialed_send_https_gaps(qualified),
        (1, 0),
        "{qualified}"
    );
}

#[test]
fn p5_query_client_execute_is_a_send() {
    let http = "async fn f() { let query = client; query.execute(request).await?; }";
    assert_eq!(credentialed_send_https_gaps(http), (1, 1), "{http}");
    let guarded = "async fn f() { if parsed.scheme() != \"https\" { return Err(\"x\".into()); } let query = client; query.execute(request).await?; }";
    assert_eq!(credentialed_send_https_gaps(guarded), (1, 0), "{guarded}");
    let db = "async fn f() { let q = sqlx::query(\"select 1\"); q.execute(&self.pool).await?; }";
    assert_eq!(credentialed_send_https_gaps(db), (0, 0), "{db}");
    let spelled = "async fn f() { query.execute(&self.pool).await?; }";
    assert_eq!(credentialed_send_https_gaps(spelled), (1, 1), "{spelled}");
}

#[test]
fn chunk02_unwrap_or_parse_binds_outer_url() {
    let nested = [
        r#"async fn f() { let parsed = Url::parse(evil).unwrap_or(Url::parse(url).unwrap()); if parsed.scheme() != "https" { return Err("x".into()); } client.get(&url).send().await?; }"#,
        r#"async fn f() { let parsed = Url::parse(&evil).unwrap_or_else(|_| Url::parse(url).unwrap()); if parsed.scheme() != "https" { return Err("x".into()); } client.get(&url).send().await?; }"#,
        r#"async fn f() { let parsed = url::Url::parse(evil).unwrap_or(Url::parse(&url).unwrap()); if parsed.scheme() != "https" { return Err("x".into()); } client.get(url).send().await?; }"#,
    ];
    for sample in nested {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
    }
    let kept = [
        r#"async fn f() { let parsed = Url::parse(url).unwrap_or(Url::parse(fallback).unwrap()); if parsed.scheme() != "https" { return Err("x".into()); } client.get(&url).send().await?; }"#,
        r#"async fn f() { let parsed = url::Url::parse(&url).unwrap_or(Url::parse(evil).unwrap()); if parsed.scheme() != "https" { return Err("x".into()); } client.get(&url).send().await?; }"#,
        r#"async fn f() { let parsed = (Url::parse(&url)).unwrap(); if parsed.scheme() != "https" { return Err("x".into()); } client.get(&url).send().await?; }"#,
    ];
    for sample in kept {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 0), "{sample}");
    }
}

/// `.map(…)` / `.and_then(…)` replaces the parsed value, so the guard
/// subject checks the closure's result — a decoy there must not cover the
/// sent URL the way the head `Url::parse(&url)` alone would.
#[test]
fn chunk02_map_and_then_parse_do_not_cover_dest() {
    let decoy = [
        r#"async fn f() { let parsed = Url::parse(&url).map(|_| decoy); if parsed.scheme() != "https" { return Err("x".into()); } client.get(&url).send().await?; }"#,
        r#"async fn f() { let parsed = Url::parse(&url).and_then(|_| Url::parse(decoy)); if parsed.scheme() != "https" { return Err("x".into()); } client.get(&url).send().await?; }"#,
        r#"async fn f() { let parsed = url::Url::parse(url).map(|p| if p.scheme() == "https" { decoy } else { decoy }); if parsed.scheme() != "https" { return Err("x".into()); } client.get(url).send().await?; }"#,
        r#"async fn f() { let parsed = (Url::parse(&url)).map(|_| decoy); if parsed.scheme() != "https" { return Err("x".into()); } client.get(&url).send().await?; }"#,
    ];
    for sample in decoy {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
    }
    let kept = [
        r#"async fn f() { let parsed = Url::parse(&url); if parsed.scheme() != "https" { return Err("x".into()); } client.get(&url).send().await?; }"#,
        r#"async fn f() { let parsed = Url::parse(&url).map_err(|e| e.to_string())?; if parsed.scheme() != "https" { return Err("x".into()); } client.get(&url).send().await?; }"#,
        r#"async fn f() { let parsed = (Url::parse(&url)).map_err(|e| format!("{e}")); if parsed.scheme() != "https" { return Err("x".into()); } client.get(&url).send().await?; }"#,
    ];
    for sample in kept {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 0), "{sample}");
    }
}
