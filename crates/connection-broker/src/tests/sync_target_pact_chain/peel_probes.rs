//! Probes for the RHS wrapper peel: strings, blocks, grouping parens.
use super::super::super::sync_target_pact_https::credentialed_send_https_gaps;

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
        assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
    }
}

#[test]
fn council_p1_comment_semicolon_does_not_break_block_tail() {
    let hits = [
        "fn f() { let dispatch = { Path::send /* ; */ }; dispatch(request); }",
        "fn f() { let dispatch = { Path::send // ;\n }; dispatch(request); }",
        "fn f() { let dispatch = { Path::send /* { ; } */ }; dispatch(request); }",
    ];
    for sample in hits {
        assert_eq!(
            super::super::dispatch_alias_calls(sample).len(),
            1,
            "{sample}"
        );
    }
    let gaps = [
        r#"async fn f() { let dispatch = { Path::send /* ; */ }; dispatch(request).await?; }"#,
        "async fn f() { let dispatch = { Path::send // ;\n }; dispatch(request).await?; }",
    ];
    for sample in gaps {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
    }
    let guarded = r#"async fn f() { if parsed.scheme() != "https" { return Err("x".into()); } let dispatch = { Path::send /* ; */ }; dispatch(request).await?; }"#;
    assert_eq!(credentialed_send_https_gaps(guarded), (1, 0));
    let stopped = "fn f() { let dispatch = { Path::send; /* } */ }; dispatch(request); }";
    assert!(
        super::super::dispatch_alias_calls(stopped).is_empty(),
        "{stopped}"
    );
}

/// `(Path::send::<A, B>)`: the comma sits inside the turbofish, so the parens
/// are grouping and the alias value unwraps to the function item (Kimi
/// council r2 chunk02 — the grouping comma scan tracks `<>`).
#[test]
fn kimi_council_r2_turbofish_comma_paren_is_grouping() {
    let hits = [
        "fn f() { let dispatch = (Path::send::<A, B>); dispatch(request); }",
        "fn f() { let dispatch = (Path::send::<A, B>) as fn(&R) -> F; dispatch(request); }",
    ];
    for sample in hits {
        assert_eq!(
            super::super::dispatch_alias_calls(sample).len(),
            1,
            "a turbofish comma is not a tuple comma: {sample}"
        );
    }
    let unguarded = r#"async fn f() { let request = client.get(evil); let dispatch = (Path::send::<A, B>); dispatch(request).await?; }"#;
    assert_eq!(
        credentialed_send_https_gaps(unguarded),
        (1, 1),
        "{unguarded}"
    );
    // A real depth-0 comma still means a tuple, not a grouping paren.
    let tuple = "fn f() { let pair = (Path::send, other); pair(request); }";
    assert!(
        super::super::dispatch_alias_calls(tuple).is_empty(),
        "a tuple value is not a forwarded alias: {tuple}"
    );
}
