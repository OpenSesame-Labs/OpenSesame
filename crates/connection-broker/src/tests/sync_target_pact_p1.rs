//! Council P1 closures: unrelated URL bindings, `.execute` receivers, UFCS body reads.
use super::sync_target_pact_https::credentialed_send_https_gaps;
use super::sync_target_pact_scan::response_body_reads;

#[test]
fn decoy_scheme_on_unrelated_url_is_a_missing_send() {
    let samples = [
        r#"async fn f() { if decoy.scheme() != "https" { return Err("x".into()); } let request = other; request.send().await?; }"#,
        r#"async fn f() { if decoy.scheme() != "https" { return Err("x".into()); } client.get(url.clone()).send().await?; }"#,
        r#"async fn f() { if decoy.scheme() != "https" { return Err("x".into()); } client.get(url,).send().await?; }"#,
        r#"async fn f() { if safe.scheme() != "https" { return Err("x".into()); } request = client.get(safe); request = other; request.send().await?; }"#,
        r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } { let url = other; client.get(url).send().await?; } }"#,
        r#"async fn f() { let parsed = Url::parse(url).unwrap(); url = evil; if parsed.scheme() != "https" { return Err("x".into()); } client.get(url).send().await?; }"#,
    ];
    for sample in samples {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
    }
}

#[test]
fn execute_on_clone_ref_and_alias_is_credentialed() {
    let forms = [
        "self.http.clone().execute(request).await?",
        "(&client).execute(request).await?",
        "let http_client = self.http; http_client.execute(request).await?",
    ];
    for form in forms {
        let bare = format!("async fn f() {{ {form} }}");
        assert_eq!(credentialed_send_https_gaps(&bare), (1, 1), "{form}");
        let guarded = format!(
            "async fn f() {{ if parsed.scheme() != \"https\" {{ return Err(\"x\".into()); }} {form} }}"
        );
        assert_eq!(credentialed_send_https_gaps(&guarded), (1, 0), "{form}");
    }
}

#[test]
fn ufcs_from_into_headers_and_streams_are_body_reads() {
    for sample in [
        "Into::into(response)",
        "reqwest::Body::from(response)",
        "http::Response::from(response).into_body()",
        "Response::headers(&response)",
        "response.headers_mut()",
        "Response::headers_mut(&mut response)",
        "StreamExt::fold(response, 0, |a, _| a)",
        "TryStreamExt::try_next(&mut response)",
    ] {
        let reads = response_body_reads(sample);
        assert!(
            !reads.is_empty(),
            "provider bytes must stay discarded: {sample} -> {reads:?}"
        );
    }
    for sample in [
        "SyncTargetView::from(row)",
        "\"https\".into()",
        "rows.into_iter().map(SyncTargetView::from).collect()",
        "let status = response.status();",
    ] {
        let reads = response_body_reads(sample);
        assert!(
            reads.is_empty(),
            "unrelated from/into is not a body read: {sample} -> {reads:?}"
        );
    }
}
