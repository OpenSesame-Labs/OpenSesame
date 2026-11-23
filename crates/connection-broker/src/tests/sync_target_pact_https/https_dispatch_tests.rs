use crate::tests::sync_target_pact_https::credentialed_send_https_gaps;
const GUARD: &str =
    r#"if parsed.scheme() != "https" { return Err("sync egress requires https".into()); }"#;

#[test]
fn execute_and_ufcs_send_are_credentialed_dispatch() {
    let forms = [
        "request.send().await?",
        "request./*c*/send().await?",
        "RequestBuilder::send(request).await?",
        "reqwest::RequestBuilder::send(request).await?",
        "<RequestBuilder>::send(request).await?",
        "RequestBuilder::send::<()>(request).await?",
        "::send(request).await?",
        "Client::execute(&client, request).await?",
        "reqwest::Client::execute(&client, request).await?",
        "<Client>::execute(&client, request).await?",
        "client.execute(request).await?",
        "Client::execute::<()>(&client, request).await?",
        // `>` inside `{…}` is a comparison and `->` is a return type;
        // neither ends the turbofish.
        "request.send::<{ 1 > 0 }>().await?",
        "request.send::<Bar<{ 1 > 0 }>>().await?",
        "request.send::<fn() -> R>().await?",
        "RequestBuilder::send::<{ 1 > 0 }>(request).await?",
    ];
    for form in forms {
        let guarded = format!("async fn f() {{ {GUARD} {form} }}");
        assert_eq!(credentialed_send_https_gaps(&guarded), (1, 0), "{form}");
        let bare = format!("async fn f() {{ {form} }}");
        assert_eq!(credentialed_send_https_gaps(&bare), (1, 1), "{form}");
    }
}

#[test]
fn one_scheme_predicate_covers_only_later_dispatch_in_that_function() {
    let both = "async fn f() { if parsed.scheme() != \"https\" { return Err(\"x\".into()); } Client::execute(&client, request).await?; RequestBuilder::send(request).await?; request.send().await?; }";
    assert_eq!(credentialed_send_https_gaps(both), (3, 0));
    let partial = "async fn f() { Client::execute(&client, request).await?; if parsed.scheme() != \"https\" { return Err(\"x\".into()); } RequestBuilder::send(request).await?; }";
    assert_eq!(credentialed_send_https_gaps(partial), (2, 1));
    let cross = "async fn first() { if parsed.scheme() != \"https\" { return Err(\"x\".into()); } Client::execute(&client, request).await?; } async fn second() { RequestBuilder::send(request).await?; }";
    assert_eq!(credentialed_send_https_gaps(cross), (2, 1));
    let nested = "async fn outer() { if parsed.scheme() != \"https\" { return Err(\"x\".into()); } async fn inner() { request.send().await?; } }";
    assert_eq!(credentialed_send_https_gaps(nested), (1, 1));
}

#[test]
fn scheme_predicate_is_required_and_comment_or_string_text_is_not() {
    let equivalents = [
        r#"if parsed.scheme() != "https" { return Err("x".into()); }"#,
        r#"if url.scheme() != "https" { return Err("x".into()); }"#,
        r#"if (parsed.scheme()) != "https" { return Err("x".into()); }"#,
        r#"if Url::scheme(&parsed) != "https" { return Err("x".into()); }"#,
        r#"if parsed.scheme().ne("https") { return Err("x".into()); }"#,
        r#"if parsed.scheme() != ("https") { return Err("x".into()); }"#,
        r#"if !!(parsed.scheme() != "https") { return Err("x".into()); }"#,
        r#"if !(!(parsed.scheme().ne("https"))) { return Err("x".into()); }"#,
        r#"if parsed.scheme() != "https" || allow_plain { return Err("x".into()); }"#,
        r#"if !allow || parsed.scheme() != "https" { return Err("x".into()); }"#,
        r#"if !(parsed.scheme() != "https") || parsed.scheme() != "https" { return Err("x".into()); }"#,
    ];
    for guard in equivalents {
        let source = format!("async fn f() {{ {guard} request.send().await?; }}");
        assert_eq!(credentialed_send_https_gaps(&source), (1, 0), "{guard}");
    }
    let not_guards = [
        r#"let _ = "sync egress requires https";"#,
        r#"if parsed.scheme() != "http" { return Err("sync egress requires https".into()); }"#,
        r#"if color_scheme() != "https" { return Err("x".into()); }"#,
        r#"if parsed.scheme() != "https-only" { return Err("x".into()); }"#,
        "// parsed.scheme() != \"https\"",
        "/* parsed.scheme() != \"https\" */",
        "/* sync egress requires https */",
        r#"assert!(parsed.scheme() != "https");"#,
        r#"if parsed.scheme() != "https" { let _ = 1; }"#,
        r#"let ok = parsed.scheme() != "https";"#,
        r#"if parsed.scheme().ne("https") { let _ = 1; }"#,
        r#"if !(parsed.scheme() != "https") { return Err("x".into()); }"#,
        r#"if !(parsed.scheme().ne("https")) { return Err("x".into()); }"#,
        r#"if !parsed.scheme().ne("https") { return Err("x".into()); }"#,
        r#"if !(Url::scheme(&parsed) != "https") { return Err("x".into()); }"#,
        r#"if parsed.scheme() != "https" && allow_plain { return Err("x".into()); }"#,
        r#"if !allow && !(parsed.scheme() != "https") { return Err("x".into()); }"#,
        r#"if !(parsed.scheme() != "https") || allow_plain { return Err("x".into()); }"#,
        r#"if !flag && !(parsed.scheme() != "https") { return Err("x".into()); }"#,
    ];
    for guard in not_guards {
        let source = format!("async fn f() {{ {guard}\n request.send().await?; }}");
        assert_eq!(credentialed_send_https_gaps(&source), (1, 1), "{guard}");
    }
    let raw = "async fn f() { let _ = r#\"parsed.scheme() != \"https\"#; request.send().await?; }";
    assert_eq!(credentialed_send_https_gaps(raw), (1, 1));
    let late = "async fn late() { request.send().await?; if parsed.scheme() != \"https\" { return Err(\"sync egress requires https\".into()); } }";
    assert_eq!(credentialed_send_https_gaps(late), (1, 1));
    let quoted =
        "async fn f() { let _ = \"Client::execute(client, request) and request.send()\"; }";
    assert_eq!(credentialed_send_https_gaps(quoted), (0, 0));
    let commented_call = "async fn f() { if parsed.scheme() != \"https\" { return Err(\"x\".into()); } // Client::execute(&client, request)\n request.send().await?; }";
    assert_eq!(credentialed_send_https_gaps(commented_call), (1, 0));
}

#[test]
fn function_item_aliases_are_credentialed_dispatch() {
    let guarded = "async fn f() { if parsed.scheme() != \"https\" { return Err(\"x\".into()); } let dispatch = reqwest::RequestBuilder::send; dispatch(request).await?; let f = Client::execute; f(&client, request).await?; let mut g = <Client>::execute; g(&client, request); }";
    assert_eq!(credentialed_send_https_gaps(guarded), (3, 0));
    let unguarded = "async fn kept() { if parsed.scheme() != \"https\" { return Err(\"x\".into()); } request.send().await?; } async fn extra() { let f = Client::execute; f(request).await?; }";
    assert_eq!(credentialed_send_https_gaps(unguarded), (2, 1));
    assert_eq!(
        credentialed_send_https_gaps("async fn f() { let f = Client::execute; }"),
        (0, 0)
    );
    let db = "async fn f() { sqlx::query(\"select 1\").execute(&self.pool).await?; }";
    assert_eq!(credentialed_send_https_gaps(db), (0, 0));
    let spelled = "async fn f() { let pool = request.build()?; query.execute(pool).await?; }";
    assert_eq!(credentialed_send_https_gaps(spelled), (1, 1));
    let compacted_typed =
        "async fn f() { let dispatch:_=reqwest::RequestBuilder::send; dispatch(request).await?; }";
    assert_eq!(credentialed_send_https_gaps(compacted_typed), (1, 1));
    let compacted_guarded = format!(
        "async fn f() {{ {GUARD} let dispatch:_=reqwest::RequestBuilder::send; dispatch(request).await?; }}"
    );
    assert_eq!(credentialed_send_https_gaps(&compacted_guarded), (1, 0));
}

#[test]
fn qualified_type_on_dispatch_alias_is_a_send() {
    let named = "async fn f() { let dispatch: SendFn = reqwest::RequestBuilder::send; dispatch(request).await?; }";
    assert_eq!(credentialed_send_https_gaps(named), (1, 1));
    let qualified = "async fn f() { let dispatch: reqwest::SendFn = reqwest::RequestBuilder::send; dispatch(request).await?; }";
    assert_eq!(credentialed_send_https_gaps(qualified), (1, 1));
    let path_form =
        "async fn f() { let name::_ = reqwest::RequestBuilder::send; name(request).await?; }";
    assert_eq!(credentialed_send_https_gaps(path_form), (0, 0));
}

#[test]
fn url_binding_fails_closed_for_unrelated_or_shadowed_destinations() {
    let built = "async fn f() { if checked.scheme() != \"https\" { return Err(\"x\".into()); } let request = build_request(other); request.send().await?; }";
    assert_eq!(credentialed_send_https_gaps(built), (1, 1));
    let shadowed = "async fn f() { if url.scheme() != \"https\" { return Err(\"x\".into()); } let url = other; client.get(url).send().await?; }";
    assert_eq!(credentialed_send_https_gaps(shadowed), (1, 1));
    let other_dest = "async fn f() { let url = safe_https; if url.scheme() != \"https\" { return Err(\"x\".into()); } client.get(other).send().await?; }";
    assert_eq!(credentialed_send_https_gaps(other_dest), (1, 1));
}

#[test]
fn char_literal_before_extra_send_is_visible() {
    for literal in ["'\"'", "b'\"'", "'\\''", "'\\n'", "'\\x22'", "'\\u{22}'"] {
        let source = format!(
            "async fn kept() {{ if parsed.scheme() != \"https\" {{ return Err(\"x\".into()); }} request.send().await?; }} async fn extra() {{ let quote = {literal}; request.send().await?; }}"
        );
        assert_eq!(credentialed_send_https_gaps(&source), (2, 1), "{literal}");
    }
}

#[test]
fn negated_flag_and_scheme_is_not_an_https_guard() {
    let source = r#"async fn f() { if !flag && !(parsed.scheme() != "https") { return Err("x".into()); } request.send().await?; }"#;
    assert_eq!(credentialed_send_https_gaps(source), (1, 1));
}

#[test]
fn closure_local_return_is_not_an_https_guard() {
    for body in [
        "let reject = || return;",
        "let reject = |cx| return;",
        "let reject = async move || return;",
        "let reject = || { return; };",
        "let reject = move || return Err(\"x\".into());",
    ] {
        let source = format!(
            "async fn f() {{ if parsed.scheme() != \"https\" {{ {body} }} request.send().await?; }}"
        );
        assert_eq!(credentialed_send_https_gaps(&source), (1, 1), "{body}");
    }
    let kept = "async fn f() { if parsed.scheme() != \"https\" { let reject = || return; return Err(\"x\".into()); } request.send().await?; }";
    assert_eq!(credentialed_send_https_gaps(kept), (1, 0));
    // A `return` on the RHS of `||` / `&&` short-circuits: when `flag`
    // skips it the branch ends without returning, so the send can still
    // run over plain HTTP (Kimi council chunk04 P2).
    let logical = "async fn f() { if parsed.scheme() != \"https\" { let x = flag || return Err(\"x\".into()); } request.send().await?; }";
    assert_eq!(credentialed_send_https_gaps(logical), (1, 1));
    let both = "async fn f() { if parsed.scheme() != \"https\" { let x = flag && return Err(\"x\".into()); } request.send().await?; }";
    assert_eq!(credentialed_send_https_gaps(both), (1, 1));
    let after_logical = "async fn f() { if parsed.scheme() != \"https\" { let x = flag || other; return Err(\"x\".into()); } request.send().await?; }";
    assert_eq!(credentialed_send_https_gaps(after_logical), (1, 0));
}

#[test]
fn parenthesized_dispatch_alias_is_a_send() {
    let bare = "async fn f() { let dispatch = RequestBuilder::send; (dispatch)(request).await?; }";
    assert_eq!(credentialed_send_https_gaps(bare), (1, 1));
    let nested = "async fn f() { let dispatch = Client::execute; ((dispatch))(&client, request); }";
    assert_eq!(credentialed_send_https_gaps(nested), (1, 1));
    let guarded = "async fn f() { if parsed.scheme() != \"https\" { return Err(\"x\".into()); } let dispatch = RequestBuilder::send; (dispatch)(request).await?; }";
    assert_eq!(credentialed_send_https_gaps(guarded), (1, 0));
    let fish = "async fn f() { let dispatch = RequestBuilder::send; (dispatch)::<()>(request); }";
    assert_eq!(credentialed_send_https_gaps(fish), (1, 1));
}

#[test]
fn https_guard_must_bind_the_dispatched_url() {
    let mismatch = "async fn f() { if checked.scheme() != \"https\" { return Err(\"x\".into()); } let request = client.request(method, other); request.send().await?; }";
    assert_eq!(credentialed_send_https_gaps(mismatch), (1, 1));
    let parsed_other = "async fn f() { let checked = url::Url::parse(safe).unwrap(); if checked.scheme() != \"https\" { return Err(\"x\".into()); } let request = client.get(other); request.send().await?; }";
    assert_eq!(credentialed_send_https_gaps(parsed_other), (1, 1));
    let same = "async fn f() { let parsed = url::Url::parse(url).map_err(|e| e.to_string())?; if parsed.scheme() != \"https\" { return Err(\"sync egress requires https\".into()); } let mut request = self.http.request(parsed_method, url).header(\"A\", \"B\"); request = request.json(&body); request.send().await?; }";
    assert_eq!(credentialed_send_https_gaps(same), (1, 0));
    let direct = "async fn f() { if url.scheme() != \"https\" { return Err(\"x\".into()); } client.request(method, url).send().await?; }";
    assert_eq!(credentialed_send_https_gaps(direct), (1, 0));
    let ufcs = "async fn f() { let parsed = Url::parse(&url).unwrap(); if Url::scheme(&parsed) != \"https\" { return Err(\"x\".into()); } Client::get(&client, url).send().await?; }";
    assert_eq!(credentialed_send_https_gaps(ufcs), (1, 0));
}

/// A struct-literal scrutinee with a trailing call/`?` puts its brace
/// group before the condition's real block (`if let url = Make { x: 1 }
/// .build() { … }`). The scan must keep looking for the block past the
/// suffix: a send inside it reads the rebound value and fails closed; a
/// send after it keeps the guard (Kimi council chunk04 P2).
#[test]
fn kimi_council_r2_suffixed_struct_scrutinee_keeps_cond_let_scope() {
    let voided = [
        r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } if let url = Make { x: 1 }.build() { client.get(url).send().await?; } }"#,
        r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } while let url = Make { x: 1 }.build() { client.get(url).send().await?; } }"#,
        r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } if let url = parse(Make { x: 1 })? { client.get(url).send().await?; } }"#,
    ];
    for sample in voided {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
    }
    let kept = [
        r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } if let url = Make { x: 1 }.build() { let _ = 1; } client.get(url).send().await?; }"#,
        r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } if let url = Make { x: 1 }.build()? { let _ = 1; } client.get(url).send().await?; }"#,
    ];
    for sample in kept {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 0), "{sample}");
    }
}

/// A match-arm tuple pattern is a real binding: `(request,) => …` binds
/// the scrutinee element, so a send inside the arm must not fall back to
/// a stale outer binding (Kimi council chunk04 P2). The scrutinee here
/// carries no builder mark, so only the arm binding can attribute the
/// send's URL.
#[test]
fn kimi_council_r2_match_arm_tuple_binds_scrutinee_element() {
    let masked = [
        r#"async fn f() { let request = client.get(url); if url.scheme() != "https" { return Err("x".into()); } match (boxed,) { (request,) => { request.send().await?; } } }"#,
        r#"async fn f() { let request = client.get(url); if url.scheme() != "https" { return Err("x".into()); } match (boxed,) { other => { let _ = 1; } (request,) => { request.send().await?; } } }"#,
    ];
    for sample in masked {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
    }
    let kept = [
        r#"async fn f() { let request = client.get(evil); if url.scheme() != "https" { return Err("x".into()); } match (client.get(url),) { (request,) => { request.send().await?; } } }"#,
        r#"async fn f() { let request = client.get(evil); if url.scheme() != "https" { return Err("x".into()); } match (client.get(url),) { other => { let _ = 1; } (request,) => { request.send().await?; } } }"#,
    ];
    for sample in kept {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 0), "{sample}");
    }
    let unguarded = r#"async fn f() { match (client.get(evil),) { (request,) => { request.send().await?; } } }"#;
    assert_eq!(
        credentialed_send_https_gaps(unguarded),
        (1, 1),
        "{unguarded}"
    );
}
