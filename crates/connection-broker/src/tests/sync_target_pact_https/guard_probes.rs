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

/// Mutating the parsed subject between `Url::parse` and the predicate checks
/// a value the sent URL no longer has (Codex PRRT_kwDOTwzAKs65ukv0).
#[test]
fn codex_thread_mutated_parsed_subject_does_not_cover_dest() {
    let voided = [
        r#"async fn f() { let mut parsed = Url::parse(&url)?; parsed.set_scheme("https"); if parsed.scheme() != "https" { return Err("x".into()); } client.get(url).send().await?; }"#,
        r#"async fn f() { let mut parsed = Url::parse(&url)?; parsed = Url::parse(&other)?; if parsed.scheme() != "https" { return Err("x".into()); } client.get(url).send().await?; }"#,
    ];
    for sample in voided {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
    }
    let kept = [
        r#"async fn f() { let mut parsed = Url::parse(&url)?; if parsed.scheme() != "https" { return Err("x".into()); } client.get(url).send().await?; }"#,
        r#"async fn f() { let parsed = Url::parse(&url)?; parsed.host_str(); if parsed.scheme() != "https" { return Err("x".into()); } client.get(url).send().await?; }"#,
    ];
    for sample in kept {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 0), "{sample}");
    }
}

/// Comment bytes are not code: a commented-out fake guard must not count as
/// a fail-close HTTPS guard (GLM council chunk03 P1). The entry point strips
/// comments first, and the scanner itself must stay correct when the prefix
/// still carries comment bytes. Conditions are spelled compacted, the way
/// `compact_source` delivers them in production.
#[test]
fn glm_chunk03_commented_fake_guard_is_not_a_guard() {
    let line = r#"{// if url.scheme()!="https" { return Err("x".into()); } client.get(url)."#;
    assert!(!super::guarded(line, Some("url")), "{line}");
    let block = r#"{/* if url.scheme()!="https" { return Err("x".into()); } */ client.get(url)."#;
    assert!(!super::guarded(block, Some("url")), "{block}");
    // End-to-end control: the entry point strips the comment, gap stays open.
    let sample = "async fn f() {\n// if url.scheme() != \"https\" { return Err(\"x\".into()); }\nclient.get(url).send().await?; }";
    assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
}

/// A `return` inside `/* … */` or `//` must not satisfy `depth0_return`, so a
/// real scheme guard whose block only *seems* to return stays open (GLM
/// council chunk03 P1).
#[test]
fn glm_chunk03_commented_return_does_not_fail_close() {
    assert!(!super::depth0_return(r#"/* return Err("x"); */"#));
    assert!(!super::depth0_return(
        "// return Err(\"x\");\nside_effect();"
    ));
    assert!(super::depth0_return(" return Err(\"x\"); "));
    let block = r#"{if url.scheme()!="https" {/* return Err("x".into()); */} client.get(url)."#;
    assert!(!super::guarded(block, Some("url")), "{block}");
    let line = "{if url.scheme()!=\"https\" {\n// return Err(\"x\".into());\n} client.get(url).";
    assert!(!super::guarded(line, Some("url")), "{line}");
}

/// A comment `}` must not corrupt `guarded()`'s brace depth: a commented
/// closing brace before a real dominating `if` must not demote it below
/// depth 1 (GLM council chunk03 P1).
#[test]
fn glm_chunk03_comment_brace_does_not_corrupt_depth() {
    let prefix = "{// }\nif url.scheme()!=\"https\" { return Err(\"x\".into()); } client.get(url).";
    assert!(super::guarded(prefix, Some("url")), "{prefix}");
    // End-to-end control: the real guard still counts once comments are gone.
    let sample = "async fn f() {\n// }\nif url.scheme() != \"https\" { return Err(\"x\".into()); }\nclient.get(url).send().await?; }";
    assert_eq!(credentialed_send_https_gaps(sample), (1, 0), "{sample}");
}

/// `last_rhs` must skip comments: a commented-out later rebinding is not the
/// "last" RHS, so `// parsed = Url::parse(&url)` cannot lend `&url`
/// provenance to a subject parsed from `evil` (GLM council chunk03 P2).
#[test]
fn glm_chunk03_commented_rebind_is_not_last_rhs() {
    let source = "let parsed = Url::parse(evil); // parsed = Url::parse(&url);";
    let (rhs, _) = super::guard_parse::last_rhs(source, "parsed").expect("real binding remains");
    assert_eq!(rhs.trim(), "Url::parse(evil)", "{source}");
    let no_real = "// let parsed = Url::parse(&url);\nother();";
    assert!(
        super::guard_parse::last_rhs(no_real, "parsed").is_none(),
        "{no_real}"
    );
    // Through `guarded`: the subject parsed `evil`, so it covers no dest.
    let prefix = "{let parsed = Url::parse(evil); // parsed = Url::parse(&url);\nif parsed.scheme()!=\"https\" { return Err(\"x\".into()); } client.get(&url).";
    assert!(!super::guarded(prefix, Some("url")), "{prefix}");
    // End-to-end control: the entry point strips the comment, gap stays open.
    let sample = "async fn f() { let parsed = Url::parse(evil);\n// parsed = Url::parse(&url);\nif parsed.scheme() != \"https\" { return Err(\"x\".into()); } client.get(&url).send().await?; }";
    assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
}

/// A `return` token inside a macro invocation's token tree does not fail-close
/// the branch — the macro may never emit it (Codex PRRT_kwDOTwzAKs65wAMY).
#[test]
fn codex_thread_macro_return_token_is_not_fail_closed() {
    let open = [
        r#"async fn f() { if url.scheme() != "https" { swallow!(return Err("x".into());); } client.get(url).send().await?; }"#,
        r#"async fn f() { if url.scheme() != "https" { swallow![return Err("x".into())]; } client.get(url).send().await?; }"#,
        r#"async fn f() { if url.scheme() != "https" { let _ = emit!(return Err("x".into())); } client.get(url).send().await?; }"#,
    ];
    for sample in open {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
    }
    let kept = [
        r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } client.get(url).send().await?; }"#,
        r#"async fn f() { if url.scheme() != "https" { swallow!(1); return Err("x".into()); } client.get(url).send().await?; }"#,
    ];
    for sample in kept {
        assert_eq!(credentialed_send_https_gaps(sample), (1, 0), "{sample}");
    }
}
