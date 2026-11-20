#[cfg(test)]
mod probes {
    use crate::tests::sync_target_pact_https::credentialed_send_https_gaps;

    #[test]
    fn p5_decoy_scheme_after_builder_let_is_missing() {
        let sample = r#"async fn f() { let request = client.get(evil); if decoy.scheme() != "https" { return } request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
    }

    #[test]
    fn p5_turbofish_typed_let_and_branch_urls() {
        let fish = r#"async fn f() { if evil.scheme() != "https" { return Err("x".into()); } let request = client.get::<Body>(evil); request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(fish), (1, 0), "{fish}");
        let fish_decoy = r#"async fn f() { if decoy.scheme() != "https" { return Err("x".into()); } let request = client.get::<Body>(evil); request.send().await?; }"#;
        assert_eq!(
            credentialed_send_https_gaps(fish_decoy),
            (1, 1),
            "{fish_decoy}"
        );
        let typed = r#"async fn f() { if decoy.scheme() != "https" { return Err("x".into()); } let request: RequestBuilder = client.request::<Body>(method, evil); request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(typed), (1, 1), "{typed}");
        let branch = r#"async fn f() { let request = if cond { client.get(evil) } else { client.get(url) }; if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(branch), (1, 1), "{branch}");
        let same = r#"async fn f() { let request = if cond { client.get(url) } else { client.get(url) }; if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(same), (1, 0), "{same}");
    }

    #[test]
    fn council_p1_free_call_branches_and_comment_braces_fail_closed() {
        let gaps = [
            (
                r#"async fn f() { let request = if cond { build(evil) } else { build(url) }; if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#,
                (1, 1),
            ),
            (
                r#"async fn f() { let request = if cond { build(url) } else { build(url) }; if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#,
                (1, 0),
            ),
            (
                r#"async fn f() { let request = build(url); if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#,
                (1, 0),
            ),
            (
                "async fn f() { if cond { // }\n request = client.get(url); } else { request = client.get(evil); } if url.scheme() != \"https\" { return Err(\"x\".into()); } request.send().await?; }",
                (1, 1),
            ),
            (
                "async fn f() { if cond { /* } */ request = client.get(url); } else { request = client.get(evil); } if url.scheme() != \"https\" { return Err(\"x\".into()); } request.send().await?; }",
                (1, 1),
            ),
            (
                r#"async fn f() { if cond { request = client.get(url); } else { request = client.get(evil); } if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#,
                (1, 1),
            ),
            (
                r#"async fn f() { if cond { request = client.get(url); } else { request = client.get(url); } if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#,
                (1, 0),
            ),
        ];
        for (sample, expected) in gaps {
            assert_eq!(credentialed_send_https_gaps(sample), expected, "{sample}");
        }
    }

    /// `//` and `/* */` between `}` and `else` are still an else. A scheme
    /// check on one arm must not bless a send that can still use the other.
    #[test]
    fn chunk01_comment_before_else_stays_conditional() {
        let cases = [
            (
                "fn f() { if cond { request = client.get(evil); } // note\nelse { request = client.get(url); } request.send() }",
                Some(""),
            ),
            (
                "fn f() { if cond { request = client.get(evil); } /* c */ else { request = client.get(url); } request.send() }",
                Some(""),
            ),
            (
                "fn f() { if cond { request = client.get(evil); } /* if */ else { request = client.get(url); } request.send() }",
                Some(""),
            ),
            (
                "fn f() { if cond { request = client.get(url); } /* c */ else { request = client.get(url); } request.send() }",
                Some("url"),
            ),
            (
                "fn f() { if cond { request = client.get(url); } // else\nrequest = client.get(evil); request.send() }",
                Some("evil"),
            ),
            (
                "fn f() { if cond { request = client.get(evil); } /* else */ { request = client.get(url); } request.send() }",
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
        let bless = "async fn f() { if cond { request = client.get(evil); } /* c */ else { request = client.get(url); } if url.scheme() != \"https\" { return Err(\"x\".into()); } request.send().await?; }";
        assert_eq!(credentialed_send_https_gaps(bless), (1, 1), "{bless}");
        let same = "async fn f() { if cond { request = client.get(url); } // note\nelse { request = client.get(url); } if url.scheme() != \"https\" { return Err(\"x\".into()); } request.send().await?; }";
        assert_eq!(credentialed_send_https_gaps(same), (1, 0), "{same}");
    }

    /// `dispatch::<T>(request)` must open its argument list like
    /// `(dispatch)::<T>(request)` does, or the send escapes destination
    /// binding and any scheme predicate in the function blesses it.
    #[test]
    fn chunk02_bare_turbofish_alias_call_binds_destination() {
        let decoy = r#"async fn f() { let request = client.get(evil); let dispatch = RequestBuilder::send; if safe.scheme() != "https" { return Err("x".into()); } dispatch::<()>(request).await?; }"#;
        assert_eq!(credentialed_send_https_gaps(decoy), (1, 1), "{decoy}");
        let kept = [
            r#"async fn f() { let request = client.get(url); if url.scheme() != "https" { return Err("x".into()); } let dispatch = RequestBuilder::send; dispatch::<()>(request).await?; }"#,
            r#"async fn f() { if parsed.scheme() != "https" { return Err("x".into()); } let dispatch = RequestBuilder::send; dispatch::<()>(request).await?; }"#,
        ];
        for sample in kept {
            assert_eq!(credentialed_send_https_gaps(sample), (1, 0), "{sample}");
        }
    }

    /// `=` / `;` inside `//` or `/* */` are not statement breaks: the
    /// receiver of `.send` keeps the builder expression before them.
    #[test]
    fn chunk02_comment_breaks_do_not_cut_the_receiver() {
        let cases = [
            (
                "fn f() { client.get(url) /* x = y; z */ .send() }",
                Some("url"),
            ),
            (
                "fn f() { client.get(url) // x = y; z\n.send() }",
                Some("url"),
            ),
            ("fn f() { client.get(url) /* a; b */ .send() }", Some("url")),
            ("fn f() { client.get(url) // a;\n.send() }", Some("url")),
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
}
