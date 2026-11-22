//! Council P5 regressions for the credentialed sync pact scanner.
use super::sync_target_pact_chain::dispatch_alias_calls;
use super::sync_target_pact_https::credentialed_send_https_gaps;
use super::sync_target_pact_scan::response_body_reads;

#[path = "sync_target_pact_p5_probes.rs"]
mod probes;

pub(crate) use probes::egress_sources_disable_redirects;

fn assert_read(sample: &str) {
    let reads = response_body_reads(sample);
    assert!(
        !reads.is_empty(),
        "credentialed sync response must stay discarded: {sample} -> {reads:?}"
    );
}

fn assert_clear(sample: &str) {
    let reads = response_body_reads(sample);
    assert!(
        reads.is_empty(),
        "outbound builder json is not a response body read: {sample} -> {reads:?}"
    );
}

fn assert_gaps(sample: &str, expected: (usize, usize)) {
    assert_eq!(credentialed_send_https_gaps(sample), expected, "{sample}");
}

#[test]
fn p5_string_and_keyword_block_aliases_are_sends() {
    for sample in [
        r#"async fn f() { let dispatch = { let _ = ";"; Path::send }; dispatch(request).await?; }"#,
        r#"async fn f() { let dispatch = { let _ = "{"; Path::send }; dispatch(request).await?; }"#,
        r#"async fn f() { let dispatch = { let _ = ';'; Path::send }; dispatch(request).await?; }"#,
        r#"async fn f() { let dispatch = unsafe { Path::send }; dispatch(request).await?; }"#,
        r#"async fn f() { let dispatch = if cond { Path::send } else { Path::execute }; dispatch(request).await?; }"#,
        r#"async fn f() { let dispatch = match cond { _ => Path::send }; dispatch(request).await?; }"#,
        r#"async fn f() { let dispatch = loop { break Path::send }; dispatch(request).await?; }"#,
        r#"async fn f() { let dispatch: T = match cond { arm => Path::send }; dispatch(request).await?; }"#,
    ] {
        assert_gaps(sample, (1, 1));
    }
}

#[test]
fn p5_streamext_place_receivers_are_body_reads() {
    for sample in [
        "StreamExt::map(response.clone(), |b| b).collect()",
        "StreamExt::map(self.response, |b| b).collect()",
        "StreamExt::map(response.by_ref(), |b| b).collect()",
    ] {
        assert_read(sample);
    }
}

#[test]
fn p5_decoy_scheme_after_builder_let_is_missing() {
    let sample = r#"async fn f() { let request = client.get(evil); if decoy.scheme() != "https" { return } request.send().await?; }"#;
    assert_gaps(sample, (1, 1));
}

#[test]
fn p5_turbofish_typed_let_and_branch_urls() {
    let fish = r#"async fn f() { if evil.scheme() != "https" { return Err("x".into()); } let request = client.get::<Body>(evil); request.send().await?; }"#;
    assert_gaps(fish, (1, 0));
    let fish_decoy = r#"async fn f() { if decoy.scheme() != "https" { return Err("x".into()); } let request = client.get::<Body>(evil); request.send().await?; }"#;
    assert_gaps(fish_decoy, (1, 1));
    let typed = r#"async fn f() { if decoy.scheme() != "https" { return Err("x".into()); } let request: RequestBuilder = client.request::<Body>(method, evil); request.send().await?; }"#;
    assert_gaps(typed, (1, 1));
    let branch = r#"async fn f() { let request = if cond { client.get(evil) } else { client.get(url) }; if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#;
    assert_gaps(branch, (1, 1));
    let same = r#"async fn f() { let request = if cond { client.get(url) } else { client.get(url) }; if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#;
    assert_gaps(same, (1, 0));
}

#[test]
fn p5_raw_use_does_not_strip_body_read() {
    assert_read(r#"let r#use = response.text();"#);
    assert_read(r#"let r#use = read_bounded_body(response);"#);
}

#[test]
fn p5_use_without_as_is_an_alias() {
    assert_read(
        "use response_guard::safe_oauth_error_detail;\nsafe_oauth_error_detail(status_code)",
    );
}

#[test]
fn p5_nested_tuple_request_binding() {
    let sample = r#"async fn f() { if decoy.scheme() != "https" { return Err("x".into()); } let ((request,),) = ((client.get(evil),),); request.send().await?; }"#;
    assert_gaps(sample, (1, 1));
}

#[test]
fn p5_url_add_assign_and_nested_tuple_shadow() {
    let add = r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } url += evil; client.get(url).send().await?; }"#;
    assert_gaps(add, (1, 1));
    let nested = r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } ((url,),) = ((evil,),); client.get(url).send().await?; }"#;
    assert_gaps(nested, (1, 1));
}

#[test]
fn p5_mut_param_block_reassign_and_into_turbofish() {
    for sample in [
        "fn steal(mut r: reqwest::Response) { r.into() }",
        "{response}.into()",
        "let mut reply = other; reply = response; reqwest::Body::from(reply)",
        "fn steal(mut r: reqwest::Response) { r.into::<reqwest::Body>() }",
        "(response).into::<reqwest::Body>()",
    ] {
        assert_read(sample);
    }
}

#[test]
fn p5_debug_macros_parens_brackets_and_compare() {
    for sample in [
        r#"format!("{:?}", (response))"#,
        "dbg![response]",
        r#"format!{"{:?}", response}"#,
        r#"format!["{:?}", response]"#,
        "dbg!{response}",
        "tracing::info![?response]",
        r#"format!("{:?}", a < b, response)"#,
        "let f = <reqwest::Body as From<Response>>::from;",
    ] {
        assert_read(sample);
    }
}

#[test]
fn p5_query_client_execute_is_a_send() {
    for sample in [
        r#"async fn f() { let query = client; query.execute(request).await?; }"#,
        r#"async fn f(query: Client) { query.execute(request).await?; }"#,
        r#"async fn f() { let pool = request.build()?; query.execute(pool).await?; }"#,
        r#"async fn f() { let pool = client; pool.execute(request).await?; }"#,
        r#"async fn f() { query.execute(&self.pool).await?; }"#,
    ] {
        assert_gaps(sample, (1, 1));
    }
    for sample in [
        r#"async fn f() { sqlx::query("select 1").execute(&pool).await?; }"#,
        r#"async fn f() { let q = sqlx::query("select 1"); q.execute(&self.pool).await?; }"#,
        r#"async fn f() { let q = sqlx::query("select 1"); let run = q; run.execute(&pool).await?; }"#,
    ] {
        assert_gaps(sample, (0, 0));
    }
}

#[test]
fn p5_typed_parsed_url_guard_covers_send() {
    let sample = r#"async fn f() { let parsed: Url = Url::parse(&url); if parsed.scheme() != "https" { return } client.get(&url).send().await?; }"#;
    assert_gaps(sample, (1, 0));
}

#[test]
fn p5_url_and_content_length_are_body_reads() {
    for sample in [
        "response.url().clone()",
        "response.content_length()",
        "Response::url(&response)",
        "Response::content_length(&response)",
        "let f = Response::url;",
        "let f = response.content_length;",
        "<reqwest::Response>::url(&response)",
        "reqwest::Response::content_length(&response)",
    ] {
        assert_read(sample);
    }
}

#[test]
fn p5_builder_json_allowlist_unsafe_neighbors() {
    for safe in [
        "reqwest::RequestBuilder::json(request, &body)",
        "<RequestBuilder>::json(request, &body)",
        "<reqwest::RequestBuilder>::json(&request, &body)",
        "request.json(&body)",
    ] {
        assert_clear(safe);
    }

    for unsafe_sample in [
        "Response::json(response).await",
        "notreqwest::RequestBuilder::json(request, &body)",
        "foo::<RequestBuilder>::json(response).await",
        "use reqwest::Response as RequestBuilder;\nRequestBuilder::json(request, &body).await",
        "use reqwest::Response as RequestBuilder;\n<RequestBuilder>::json(request, &body)",
        "use reqwest::{Response as RequestBuilder};\n<RequestBuilder>::json(&request, &body)",
        "response.json(&x)",
        "RequestBuilder::json(response)",
    ] {
        assert_read(unsafe_sample);
    }
}

#[test]
fn p5_delegated_builder_json_not_a_false_positive() {
    for safe in [
        "reqwest::RequestBuilder::json(request, &body)",
        "<RequestBuilder>::json(request, &body)",
        "reqwest::RequestBuilder::json::<serde_json::Value>(request, &body)",
        "request = request.json(&body);",
    ] {
        assert_clear(safe);
    }
    assert_read("helper(&response)");
    assert_read("helper(&body)");
    assert_read("consume(&body, cap)");
    assert_read("reqwest::RequestBuilder::json(request, &body);\nhelper(&body)");
    assert_read("use reqwest::Response as RequestBuilder;\nRequestBuilder::json(request, &body)");
}

#[test]
fn p5_delegated_response_callee_is_a_body_read() {
    assert_read("consume(&response)");
    assert_read("consume(&mut response)");
    assert_read("log_upstream(&mut response, cap)");
    assert_read("helper(&(response))");
    let reads = response_body_reads("drop(response)");
    assert!(
        reads.is_empty(),
        "drop(response) is the production discard: {reads:?}"
    );
    assert_clear("drop(&response)");
}

#[test]
fn p5_tuple_and_send_response_renames_are_body_reads() {
    for sample in [
        "let (reply,) = (response,); reply.text().await",
        "let ((reply,),) = ((response,),); reply.bytes().await",
        "let reply = request.send().await?; let body: reqwest::Body = reply.into();",
        "let reply = if flag { response } else { other }; reply.into()",
        "let leaked: reqwest::Body = response.try_into().unwrap();",
        "<Response as TryInto<Body>>::try_into(response).unwrap()",
        "TryFrom::try_from(response)",
        "let aliased = response; let reply = if flag { aliased } else { other }; reply.into()",
        "let reply = client.execute(request).await?; let body: reqwest::Body = reply.into();",
    ] {
        assert_read(sample);
    }
}

#[test]
fn p5_body_from_item_without_response_call_is_clear() {
    assert_clear("let make_body = reqwest::Body::from;");
    assert_clear("let make_body = reqwest::Body::from; make_body(payload)");
    assert_read("let make_body = reqwest::Body::from; make_body(response)");
    assert_read("let make_body = reqwest::Body::from; let payload = response; make_body(payload)");
}

#[test]
fn p5_dispatch_alias_shadowing_is_not_a_send() {
    let sample = r#"async fn f() { let dispatch = RequestBuilder::send; { let dispatch = |_| (); dispatch(request).await?; } }"#;
    assert_gaps(sample, (0, 0));
}

#[test]
fn p5_unrelated_let_tuple_does_not_shadow_dispatch_alias() {
    let sample = r#"async fn f() { let dispatch = reqwest::RequestBuilder::send; let (n,) = (1,); dispatch(request).await?; }"#;
    assert_gaps(sample, (1, 1));
}

#[test]
fn p5_dispatch_rebind_without_let_shadows_alias() {
    let sample = r#"async fn f() { let dispatch = reqwest::RequestBuilder::send; dispatch = other_fn; dispatch(request).await?; }"#;
    assert_gaps(sample, (0, 0));
}

#[test]
fn p5_nested_block_comment_hides_dispatch_rebind() {
    let sample = r#"async fn f() {
    let dispatch = reqwest::RequestBuilder::send;
    /* /* */
    let dispatch = innocent;
    */
    dispatch(request).await?;
}"#;
    assert_gaps(sample, (1, 1));
}

#[test]
fn p5_closure_whitespace_before_pipe_is_not_https_guard() {
    let sample = r#"async fn f() { if evil.scheme() != "https" { let _ = || return Err("x".into()); } client.get(evil).send().await?; }"#;
    assert_gaps(sample, (1, 1));
}

#[test]
fn p5_as_str_before_send_stays_guarded() {
    let sample = r#"async fn f() { let _ = url.as_str(); if url.scheme() != "https" { return Err("x".into()); } client.get(url).send().await?; }"#;
    assert_gaps(sample, (1, 0));
}

#[test]
fn p5_build_request_multi_arg_fails_closed() {
    let sample = r#"async fn f() { if safe.scheme() != "https" { return Err("x".into()); } let request = build_request(evil, safe); request.send().await?; }"#;
    assert_gaps(sample, (1, 1));
}

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
    ] {
        assert_read(sample);
    }
    for sample in [
        "let (reply,) = (status,); reply.into()",
        "let tmp = status; let reply = tmp; let tmp = response; reply.into()",
        "drop::<T>(&response)",
        "reqwest::RequestBuilder::json::<serde_json::Value>(request, &body)",
    ] {
        assert_clear(sample);
    }
}
