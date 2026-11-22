//! Probes for branch/else merge behavior: braceless arms, comments around
//! `else`, and comments that must not cut a receiver chain.
use crate::tests::sync_target_pact_https::credentialed_send_https_gaps;

/// `else request = client.get(url);` is a braceless expression arm, not a
/// diverging one: it falls through to the next statement, so the arm merge
/// must still run and disagreeing URLs fail closed instead of the else-arm
/// overwriting the if-arm exit past a scheme guard that does not cover it
/// (GLM council chunk02 P1).
#[test]
fn chunk02_braceless_else_expression_arm_merges_fail_closed() {
    let cases = [
        (
            "fn f() { request = client.get(evil); if cond { request = client.get(url); } else request = client.get(evil); request.send() }",
            Some(""),
        ),
        (
            "fn f() { request = client.get(url); if cond { request = client.get(url); } else request = client.get(url); request.send() }",
            Some("url"),
        ),
    ];
    for (sample, expected) in cases {
        let open = sample.find('{').expect("fn body");
        let at = sample.find(".send").expect("send");
        assert_eq!(
            super::super::dispatch_url(sample, open, at).as_deref(),
            expected,
            "{sample}"
        );
    }
    let bless = r#"async fn f() { let request = client.get(url); if c1 { request = client.get(evil); } else request = client.get(url); if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#;
    assert_eq!(credentialed_send_https_gaps(bless), (1, 1), "{bless}");
    let same = r#"async fn f() { let request = client.get(url); if c1 { request = client.get(url); } else request = client.get(url); if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#;
    assert_eq!(credentialed_send_https_gaps(same), (1, 0), "{same}");
    // A diverging braceless arm keeps the short-circuit: only the if-arm
    // exit is live after it (contrast the expression arm above).
    let diverging =
        "fn f() { request = client.get(url); if c1 { request = client.get(evil); } else return; request.send() }";
    let open = diverging.find('{').expect("fn body");
    let at = diverging.find(".send").expect("send");
    assert_eq!(
        super::super::dispatch_url(diverging, open, at).as_deref(),
        Some("evil"),
        "diverging arm must keep the if-arm exit: {diverging}"
    );
}

/// A comment between a block receiver and the next chain link is not a
/// statement break: `{ client.get(url) } /* c */ .send()` keeps the receiver
/// chain (GLM council chunk02).
#[test]
fn chunk02_comment_after_block_receiver_keeps_send_chain() {
    let cases = [
        ("fn f() { { client.get(url) }.send() }", Some("url")),
        (
            "fn f() { { client.get(url) } /* c */ .send() }",
            Some("url"),
        ),
        ("fn f() { { client.get(url) } // c\n.send() }", Some("url")),
    ];
    for (sample, expected) in cases {
        let open = sample.find('{').expect("fn body");
        let at = sample.find(".send").expect("send");
        assert_eq!(
            super::super::dispatch_url(sample, open, at).as_deref(),
            expected,
            "{sample}"
        );
    }
}
