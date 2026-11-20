//! Council P1 closures: unrelated URL bindings, `.execute` receivers, UFCS body reads.
use super::sync_target_pact_chain::{dispatch_alias_calls, response_chain_consumer};
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
fn nested_scheme_if_does_not_dominate_later_send() {
    let samples = [
        r#"async fn f() { if ready { if url.scheme() != "https" { return Err("x".into()); } } client.get(url).send().await?; }"#,
        r#"async fn f() { if false { if parsed.scheme() != "https" { return Err("x".into()); } } request.send().await?; }"#,
        r#"async fn f() { if ready { } else if url.scheme() != "https" { return Err("x".into()); } client.get(url).send().await?; }"#,
    ];
    for sample in samples {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
    }
    let dominates = r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } client.get(url).send().await?; }"#;
    assert_eq!(credentialed_send_https_gaps(dominates), (1, 0));
}

#[test]
fn post_check_url_mutation_is_not_guarded() {
    let samples = [
        r#"async fn f() { if parsed.scheme() != "https" { return Err("x".into()); } parsed.set_scheme("http"); client.get(parsed).send().await?; }"#,
        r#"async fn f() { let parsed = Url::parse(&url).unwrap(); if parsed.scheme() != "https" { return Err("x".into()); } url.clone_from(&evil); client.get(&url).send().await?; }"#,
        r#"async fn f() { let parsed = Url::parse(&url).unwrap(); if parsed.scheme() != "https" { return Err("x".into()); } url.push_str(evil); client.get(&url).send().await?; }"#,
        r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } std::mem::swap(&mut url, &mut evil); client.get(url).send().await?; }"#,
    ];
    for sample in samples {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
    }
    let kept = r#"async fn f() { let parsed = Url::parse(&url).unwrap(); if parsed.scheme() != "https" { return Err("x".into()); } client.get(&url).send().await?; }"#;
    assert_eq!(credentialed_send_https_gaps(kept), (1, 0));
}

#[test]
fn forwarded_dispatch_alias_is_a_credentialed_send() {
    let bare = r#"async fn f() { let dispatch = reqwest::RequestBuilder::send; let call = dispatch; call(request).await?; }"#;
    assert_eq!(credentialed_send_https_gaps(bare), (1, 1));
    let guarded = r#"async fn f() { if parsed.scheme() != "https" { return Err("x".into()); } let dispatch = reqwest::RequestBuilder::send; let call = dispatch; call(request).await?; }"#;
    assert_eq!(credentialed_send_https_gaps(guarded), (1, 0));
    let again = r#"async fn f() { let dispatch = reqwest::RequestBuilder::send; let call = dispatch; let again = call; again(request).await?; }"#;
    assert_eq!(credentialed_send_https_gaps(again), (1, 1));
    let tuple = r#"async fn f() { let (dispatch,) = (reqwest::RequestBuilder::send,); dispatch(request).await?; }"#;
    assert_eq!(credentialed_send_https_gaps(tuple), (1, 1));
    let tuple_guarded = r#"async fn f() { if parsed.scheme() != "https" { return Err("x".into()); } let (dispatch,) = (reqwest::RequestBuilder::send,); dispatch(request).await?; }"#;
    assert_eq!(credentialed_send_https_gaps(tuple_guarded), (1, 0));
}

#[test]
fn response_metadata_reads_are_body_reads() {
    for sample in [
        "let f = reqwest::Response::headers; f(&response)",
        "let f = response.headers; f()",
        "let f = http::Response::into_body; f(response)",
        "let convert = reqwest::Body::from; let payload = convert(response); payload.collect().await",
        "format!(\"{response:?}\")",
        "format!(\"{:?}\", response)",
        "let reply = response; format!(\"{reply:?}\")",
        "dbg!(&response)",
        "dbg!(response)",
        "response.error_for_status()",
        "format!(\"{}\", response.error_for_status().unwrap_err())",
        "let show = Response::error_for_status;",
    ] {
        let reads = response_body_reads(sample);
        assert!(
            !reads.is_empty(),
            "provider metadata must stay discarded: {sample} -> {reads:?}"
        );
    }
    for sample in [
        "format!(\"upstream {status}\")",
        "format!(\"{:?}\", status)",
        "format!(\"{:?}\", response.status())",
        "let status = response.status();",
        "format!(\"{reply:?}\")",
        "rows.into_iter().map(SyncTargetView::from).collect()",
        "dbg!(status)",
    ] {
        let reads = response_body_reads(sample);
        assert!(
            reads.is_empty(),
            "status display is not provider metadata: {sample} -> {reads:?}"
        );
    }
}

/// Free `request.send()` has no local builder URL. A `parsed.scheme()` check in
/// that function is accepted on purpose; a guard of a different binding is not.
/// `http_provider_json` parses and sends the same `url`, so it does not rely on this.
#[test]
fn free_floating_scheme_guard_covers_only_an_unresolved_send() {
    let floating = r#"async fn f() { if parsed.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#;
    assert_eq!(credentialed_send_https_gaps(floating), (1, 0));
    let execute = r#"async fn f() { if parsed.scheme() != "https" { return Err("x".into()); } client.execute(request).await?; }"#;
    assert_eq!(credentialed_send_https_gaps(execute), (1, 0));
    let decoy = r#"async fn f() { if decoy.scheme() != "https" { return Err("x".into()); } let request = other; request.send().await?; }"#;
    assert_eq!(credentialed_send_https_gaps(decoy), (1, 1));
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

#[test]
fn post_check_ufcs_replace_ref_and_tuple_assignment_is_not_guarded() {
    let samples = [
        r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } Url::set_scheme(&mut url, "http"); client.get(url).send().await?; }"#,
        r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } std::mem::replace(&mut url, evil); client.get(url).send().await?; }"#,
        r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } let u = &mut url; u.set_scheme("http"); client.get(url).send().await?; }"#,
        r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } (url,) = (evil,); client.get(url).send().await?; }"#,
    ];
    for sample in samples {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
    }
}

#[test]
fn reassigned_and_block_dispatch_aliases_are_credentialed_sends() {
    let bare = r#"async fn f() { let dispatch = reqwest::RequestBuilder::send; let mut call = other_fn; call = dispatch; call(request).await?; }"#;
    assert_eq!(credentialed_send_https_gaps(bare), (1, 1));
    let guarded = r#"async fn f() { if parsed.scheme() != "https" { return Err("x".into()); } let dispatch = reqwest::RequestBuilder::send; let mut call = other_fn; call = dispatch; call(request).await?; }"#;
    assert_eq!(credentialed_send_https_gaps(guarded), (1, 0));
    let block = r#"async fn f() { let dispatch = reqwest::RequestBuilder::send; let call = { dispatch }; call(request).await?; }"#;
    assert_eq!(credentialed_send_https_gaps(block), (1, 1));
    let block_guarded = r#"async fn f() { if parsed.scheme() != "https" { return Err("x".into()); } let dispatch = reqwest::RequestBuilder::send; let call = { dispatch }; call(request).await?; }"#;
    assert_eq!(credentialed_send_https_gaps(block_guarded), (1, 0));
}

/// Parens, braces, `&` / `*`, block tails, nested tuples, and `name = Path::send`.
#[test]
fn wrapped_rhs_dispatch_aliases_are_credentialed_sends() {
    let forms = [
        "let dispatch = (reqwest::RequestBuilder::send); dispatch(request).await?",
        "let dispatch = { reqwest::RequestBuilder::send }; dispatch(request).await?",
        "let dispatch = &reqwest::RequestBuilder::send; dispatch(request).await?",
        "let dispatch = *&reqwest::RequestBuilder::send; dispatch(request).await?",
        "let dispatch = reqwest::RequestBuilder::send; let call = { let _ = 1; dispatch }; call(request).await?",
        "let (dispatch,) = ((reqwest::RequestBuilder::send),); dispatch(request).await?",
        "let dispatch = { { reqwest::RequestBuilder::send } }; dispatch(request).await?",
        "let dispatch = reqwest::RequestBuilder::send; let call = &dispatch; call(request).await?",
        "let mut dispatch = other_fn; dispatch = reqwest::RequestBuilder::send; dispatch(request).await?",
    ];
    for form in forms {
        let bare = format!("async fn f() {{ {form} }}");
        assert_eq!(credentialed_send_https_gaps(&bare), (1, 1), "{form}");
        let guarded = format!(
            "async fn f() {{ if parsed.scheme() != \"https\" {{ return Err(\"x\".into()); }} {form} }}"
        );
        assert_eq!(credentialed_send_https_gaps(&guarded), (1, 0), "{form}");
    }
    let not_a_binding = [
        "let dispatch = foo(reqwest::RequestBuilder::send); dispatch(request).await?",
        "let dispatch = (reqwest::RequestBuilder::send,); dispatch(request).await?",
        "let dispatch = { reqwest::RequestBuilder::send; }; dispatch(request).await?",
    ];
    for form in not_a_binding {
        let source = format!("async fn f() {{ {form} }}");
        assert_eq!(credentialed_send_https_gaps(&source), (0, 0), "{form}");
    }
}

#[test]
fn question_mark_and_ufcs_stream_map_are_body_reads() {
    for sample in [
        "response.map(|b| b).collect()",
        "response.map(|b| b)?.collect()",
        "response.map(|b| b).await?.collect()",
        "StreamExt::map(response, |b| b).collect()",
        "futures::StreamExt::map(&mut response, |b| b).collect()",
        "rows.into_iter().map(SyncTargetView::from).collect()",
    ] {
        let reads = response_body_reads(sample);
        let body = sample.starts_with("response") || sample.contains("StreamExt::map");
        assert_eq!(!reads.is_empty(), body, "{sample} -> {reads:?}");
    }
}

#[test]
fn destructured_request_binding_ignores_unrelated_scheme_guard() {
    let decoy = r#"async fn f() { let parsed = Url::parse(safe).unwrap(); if parsed.scheme() != "https" { return Err("x".into()); } let (request,) = (client.get(evil),); request.send().await?; }"#;
    assert_eq!(credentialed_send_https_gaps(decoy), (1, 1));
    let kept = r#"async fn f() { let (request,) = (client.get(url),); if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#;
    assert_eq!(credentialed_send_https_gaps(kept), (1, 0));
    let rebound = r#"async fn f() { if safe.scheme() != "https" { return Err("x".into()); } let (request, _) = (other, flag); request.send().await?; }"#;
    assert_eq!(credentialed_send_https_gaps(rebound), (1, 1));
}

#[test]
fn logging_macros_and_ufcs_header_reads_are_metadata() {
    for sample in [
        r#"tracing::info!("{:?}", response)"#,
        r#"log::debug!("{:?}", response)"#,
        r#"anyhow!("{:?}", response)"#,
        r#"tracing::info!(?response)"#,
        r#"format!("{r:?}", r = response)"#,
        r#"tracing::info!(field = ?response)"#,
        "Response::headers::<http::HeaderMap>(&response)",
        "reqwest::Response::headers_mut::<()>(&mut response)",
        "<reqwest::Response>::headers(&response)",
    ] {
        let reads = response_body_reads(sample);
        assert!(
            !reads.is_empty(),
            "provider metadata must stay discarded: {sample} -> {reads:?}"
        );
    }
    for sample in [
        r#"tracing::info!(sync_target_id = %row.id, project_id = %row.project_id, "sync target created")"#,
        r#"log::debug!("{:?}", status)"#,
        r#"format!("{r:?}", r = status)"#,
        r#"tracing::info!("{:?}", response.status())"#,
        r#"format!("{:?}", response.status())"#,
        "reqwest::RequestBuilder::header(&request, \"Accept\", \"application/json\")",
    ] {
        let reads = response_body_reads(sample);
        assert!(
            reads.is_empty(),
            "status and request headers are not response metadata: {sample} -> {reads:?}"
        );
    }
}

/// A bare `dispatch = Path::send` after `if` / `loop` is still a credentialed
/// send. `}` must bound the previous block, so a `;` inside that block is not
/// the statement tail.
#[test]
fn chunk01_bare_dispatch_after_if_or_loop_is_a_send() {
    let forms = [
        "if cond { let _ = 1; } dispatch = reqwest::RequestBuilder::send; dispatch(request).await?",
        "if cond { return; } dispatch = Path::send; dispatch(request).await?",
        "loop { break; } dispatch = Path::send; dispatch(request).await?",
        "loop { break } dispatch = Path::send; dispatch(request).await?",
        "if cond { a; } else { b; } dispatch = Path::send; dispatch(request).await?",
        "if cond { let _ = 1; } let dispatch = Path::send; dispatch(request).await?",
    ];
    for form in forms {
        let bare = format!("async fn f() {{ {form} }}");
        assert_eq!(credentialed_send_https_gaps(&bare), (1, 1), "{form}");
        let guarded = format!(
            "async fn f() {{ if parsed.scheme() != \"https\" {{ return Err(\"x\".into()); }} {form} }}"
        );
        assert_eq!(credentialed_send_https_gaps(&guarded), (1, 0), "{form}");
    }
    let commented = [
        "fn f() { if cond { a; } /* } */ dispatch = Path::send; dispatch(request); }",
        "fn f() { loop { break; } // }\n dispatch = Path::send; dispatch(request); }",
        "fn f() { if cond { a; } /* c */ dispatch = Path::send; dispatch(request); }",
    ];
    for sample in commented {
        assert_eq!(dispatch_alias_calls(sample).len(), 1, "{sample}");
    }
    let not_send =
        "async fn f() { if cond { let _ = 1; } dispatch = other_fn; dispatch(request).await? }";
    assert_eq!(credentialed_send_https_gaps(not_send), (0, 0), "{not_send}");
}

/// Compaction must not weld `/` `*` into a block comment that swallows the
/// rest of the function, nor `&` `&` into the `&&` the HTTPS guard splits on.
#[test]
fn chunk03_compact_source_keeps_token_boundaries() {
    let compact = super::sync_target_pact_norm::compact_source(
        "let x = a / *ptr; let y = & &z; let s = \"a / *ptr\";",
    );
    assert_eq!(compact, "let x=a/ *ptr;let y=& &z;let s=\"a / *ptr\";");
    let read = r#"async fn f() { let x = a / *ptr; response.text().await; }"#;
    assert!(!response_body_reads(read).is_empty(), "{read}");
    let send = r#"async fn f() { let x = a / *ptr; client.get(evil).send().await?; }"#;
    assert_eq!(credentialed_send_https_gaps(send), (1, 1), "{send}");
}

/// Whitespace or a comment between the alias name and its argument list does
/// not turn a call into a non-call.
#[test]
fn chunk01_gap_before_alias_call_parens_is_a_send() {
    let hits = [
        "fn f() { let dispatch = Path::send; dispatch (request); }",
        "fn f() { let dispatch = Path::send; dispatch /* c */ (request); }",
        "fn f() { let dispatch = Path::send; dispatch\n(request); }",
        "fn f() { let dispatch = Path::send; dispatch::<T> (request); }",
        "fn f() { let dispatch = Path::send; dispatch ::<T> (request); }",
        "fn f() { let dispatch = Path::send; (dispatch) /* c */ (request); }",
        "fn f() { let dispatch = Path::send; (dispatch) /* c */ ::<T> (request); }",
    ];
    for sample in hits {
        assert_eq!(dispatch_alias_calls(sample).len(), 1, "{sample}");
    }
    let misses = [
        "fn f() { let dispatch = Path::send; dispatch; }",
        "fn f() { let dispatch = Path::send; dispatch /* (request) */; }",
        "fn f() { let dispatch = Path::send; let other = dispatch; }",
        "fn f() { let dispatch = Path::send; match dispatch { _ => () } }",
    ];
    for sample in misses {
        assert!(dispatch_alias_calls(sample).is_empty(), "{sample}");
    }
}

/// `/* ) */` and `/* , */` are not code, so the chain root stays the response.
#[test]
fn chunk01_comment_paren_keeps_response_root() {
    let hits = [
        "response.map(|b| /* ) */ b).collect()",
        "response.map(|b| /* ) */ b)?.collect()",
        "StreamExt::map(/* , */ response, |b| b).collect()",
        "StreamExt::map(/* ) */ response, |b| b).collect()",
        "futures::StreamExt::map(/* , */ &mut response, |b| b).count()",
    ];
    for sample in hits {
        assert!(
            response_chain_consumer(sample),
            "comment must not drop the response root: {sample}"
        );
        assert!(!response_body_reads(sample).is_empty(), "{sample}");
    }
    let misses = [
        "rows.map(|b| /* ) */ b).collect()",
        "StreamExt::map(/* , */ rows, |b| b).collect()",
        "\"response.map(|b| /* ) */ b).collect()\"",
    ];
    for sample in misses {
        assert!(
            !response_chain_consumer(sample),
            "unrelated chain is not a response read: {sample}"
        );
        assert!(response_body_reads(sample).is_empty(), "{sample}");
    }
}
