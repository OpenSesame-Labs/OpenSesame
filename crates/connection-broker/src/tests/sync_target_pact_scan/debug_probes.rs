use crate::tests::sync_target_pact_scan::response_body_reads;

#[test]
fn p5_url_and_content_length_are_metadata() {
    let hits = [
        "response.url().clone()",
        "response.content_length()",
        "let reply = response; reply.url()",
        "let reply = response; reply.content_length()",
        "(response).url()",
        "(&response).content_length()",
        "Response::url(&response)",
        "reqwest::Response::content_length(&response)",
        "<reqwest::Response>::url(&response)",
        "Response::url::<()>(&response)",
        "Response::content_length(&mut response)",
        "let f = Response::url;",
        "let f = response.content_length;",
        "let f = reqwest::Response::url;",
        "let f = <reqwest::Response>::content_length;",
        "fn log(mut reply: reqwest::Response) { reply.url() }",
        "let reply = { response }; reply.content_length()",
    ];
    for sample in hits {
        assert!(
            !response_body_reads(sample).is_empty(),
            "url and length are provider metadata: {sample}"
        );
    }
    let misses = [
        "request.url()",
        "parsed.content_length()",
        "Request::url(&request)",
        "let f = Request::url;",
        "let f = request.content_length;",
        "let status = response.status();",
        "format!(\"{:?}\", response.status())",
        "\"response.url()\"",
        "response.copy_topic()",
    ];
    for sample in misses {
        assert!(
            response_body_reads(sample).is_empty(),
            "request url is not response metadata: {sample}"
        );
    }
}

/// `dbg![response]`, `format!["{:?}", response]`, `tracing::info![?response]`
/// — every Rust macro delimiter reaches the response scan.
#[test]
fn codex_thread_debug_macro_non_paren_delimiters() {
    let hits = [
        "dbg![response]",
        r#"format!["{:?}", response]"#,
        "tracing::info![?response]",
        r#"format!{"{:?}", response}"#,
        "dbg!{response}",
        "println![\"{response:?}\"]",
    ];
    for sample in hits {
        assert!(
            !response_body_reads(sample).is_empty(),
            "bracket/brace macro must read the response: {sample}"
        );
    }
    let misses = [
        "dbg![status]",
        r#"format!["{:?}", status]"#,
        "vec![response_count]",
    ];
    for sample in misses {
        assert!(
            response_body_reads(sample).is_empty(),
            "unrelated macro argument is not a body read: {sample}"
        );
    }
}

/// A `Body::from` alias is only a read when a later invocation receives a
/// response-derived argument (Codex review).
#[test]
fn codex_thread_body_from_alias_traces_response_invocation() {
    let hits = [
        "let make_body = reqwest::Body::from; make_body(response)",
        "let make_body = reqwest::Body::from; let payload = response; make_body(payload)",
        "reqwest::Body::from(response)",
    ];
    for sample in hits {
        assert!(
            !response_body_reads(sample).is_empty(),
            "alias invoked with the response moves the body: {sample}"
        );
    }
    let misses = [
        "let make_body = reqwest::Body::from;",
        "let make_body = reqwest::Body::from; make_body(payload)",
        "pass(Body::from)",
    ];
    for sample in misses {
        assert!(
            response_body_reads(sample).is_empty(),
            "request-body converter without the response is not a read: {sample}"
        );
    }
}

/// Macros outside the known logging list (`audit!`, `emit!`) can format
/// and export provider metadata; flag them when an argument tracks the
/// response (Codex review).
#[test]
fn codex_thread_unknown_macro_with_response_arg_is_a_read() {
    let hits = [
        "audit!(upstream = ?response)",
        "audit![response]",
        "emit!(body = response)",
        "audit!(\"{response:?}\")",
        "let reply = response; audit!(upstream = ?reply)",
    ];
    for sample in hits {
        assert!(
            !response_body_reads(sample).is_empty(),
            "unknown macro receiving the response exports metadata: {sample}"
        );
    }
    let misses = [
        "audit!(status)",
        "audit!(\"{status:?}\")",
        "vec![1, 2, 3]",
        "emit!(body = payload)",
    ];
    for sample in misses {
        assert!(
            response_body_reads(sample).is_empty(),
            "unknown macro without the response stays clear: {sample}"
        );
    }
}

/// `{response:#?}` pretty-prints the whole body exactly like `{:?}`: the
/// pretty-debug specifier must mark the macro as a read, in every delimiter
/// (Kimi council chunk07 P1).
#[test]
fn kimi_council_r4_pretty_debug_format_is_a_read() {
    let hits = [
        r#"println!("{response:#?}")"#,
        r#"println!["{response:#?}"]"#,
        r#"format!("{response:#?}")"#,
        r#"eprintln!("{response:#?}")"#,
        r#"println!("{:?}", response)"#,
    ];
    for sample in hits {
        assert!(
            !response_body_reads(sample).is_empty(),
            "pretty-debug format must read the response: {sample}"
        );
    }
    let misses = [r#"println!("{response}")"#, r#"format!("{}", count)"#];
    for sample in misses {
        assert!(
            response_body_reads(sample).is_empty(),
            "a display (non-debug) format is not a body read: {sample}"
        );
    }
}
