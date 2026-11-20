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

    /// `;` / `{` / `}` inside a comment or string in an `if` / `else if`
    /// header must not truncate the header into a plain block: the conditional
    /// reassignment still merges fail-closed instead of leaking the arm URL
    /// past a scheme guard that does not cover it.
    #[test]
    fn chunk02_header_comment_semicolon_keeps_branch_merge() {
        let cases = [
            (
                "fn f() { request = client.get(evil); if cond /* ; */ { request = client.get(url); } request.send() }",
                Some(""),
            ),
            (
                "fn f() { request = client.get(evil); if cond /* } */ { request = client.get(url); } request.send() }",
                Some(""),
            ),
            (
                "fn f() { request = client.get(evil); if cond == \";\" { request = client.get(url); } request.send() }",
                Some(""),
            ),
            (
                "fn f() { request = client.get(evil); if cond == \"}\" { request = client.get(url); } request.send() }",
                Some(""),
            ),
            (
                "fn f() { request = client.get(evil); if c1 { request = client.get(evil); } else if c2 /* ; */ { request = client.get(url); } request.send() }",
                Some(""),
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
        let bless = "async fn f() { request = client.get(evil); if cond /* ; */ { request = client.get(url); } if url.scheme() != \"https\" { return Err(\"x\".into()); } request.send().await?; }";
        assert_eq!(credentialed_send_https_gaps(bless), (1, 1), "{bless}");
        let same = "async fn f() { request = client.get(evil); if cond /* ; */ { request = client.get(url); } else { request = client.get(url); } if url.scheme() != \"https\" { return Err(\"x\".into()); } request.send().await?; }";
        assert_eq!(credentialed_send_https_gaps(same), (1, 0), "{same}");
    }

    /// `=> /* c */ {` is still a match arm brace, and a `}` inside an arm
    /// comment must not demote it to `BraceKind::Block`; a trailing comment's
    /// `=>` must not fake an arm either.
    #[test]
    fn chunk02_match_arm_comment_brace_stays_branch() {
        let hits = [
            "fn f() { match cond { _ => /* c */ { one(); } } }",
            "fn f() { match cond { _ => /* } */ { one(); } } }",
            "fn f() { match cond { S { x } => /* c */ { one(); } } }",
        ];
        for sample in hits {
            let brace = sample.rfind('{').expect("arm brace");
            assert!(
                matches!(
                    super::super::brace_kind(sample, brace),
                    super::super::BraceKind::Branch
                ),
                "arm brace with comment must stay a branch: {sample}"
            );
        }
        let decoy = "fn f() { stmt(); /* => */ { one(); } }";
        let brace = decoy.rfind('{').expect("block brace");
        assert!(
            matches!(
                super::super::brace_kind(decoy, brace),
                super::super::BraceKind::Block
            ),
            "a comment's => must not fake a match arm: {decoy}"
        );
    }

    /// `let request = if flag { client.get(evil) } else { client.get(safe) };`
    /// must not let the last textual builder win: disagreeing branch URLs
    /// fail closed (Codex PRRT_kwDOTwzAKs65fDyj).
    #[test]
    fn codex_thread_conditional_builder_branches_fail_closed() {
        let hits = [
            (
                r#"async fn f() { if safe.scheme() != "https" { return Err("x".into()); } let request = if flag { client.get(evil) } else { client.get(safe) }; request.send().await?; }"#,
                (1, 1),
            ),
            (
                r#"async fn f() { let request = if safe.scheme() == "https" { client.get(safe) } else { client.get(evil) }; request.send().await?; }"#,
                (1, 1),
            ),
        ];
        for (sample, expected) in hits {
            assert_eq!(credentialed_send_https_gaps(sample), expected, "{sample}");
        }
        let same = r#"async fn f() { if safe.scheme() != "https" { return Err("x".into()); } let request = if flag { client.get(safe) } else { client.get(safe) }; request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(same), (1, 0), "{same}");
    }

    /// A multi-argument helper does not assign the last argument as the URL:
    /// `build_request(evil, safe)` is unresolved and fails closed rather than
    /// blessing the real destination (Codex PRRT_kwDOTwzAKs65i9Uu).
    #[test]
    fn codex_thread_multi_arg_helper_destination_unresolved() {
        let unresolved = [
            (
                r#"async fn f() { if safe.scheme() != "https" { return Err("x".into()); } let request = build_request(evil, safe); request.send().await?; }"#,
                (1, 1),
            ),
            (
                r#"async fn f() { if safe.scheme() != "https" { return Err("x".into()); } let request = if cond { build_request(evil) } else { build_request(safe) }; request.send().await?; }"#,
                (1, 1),
            ),
        ];
        for (sample, expected) in unresolved {
            assert_eq!(credentialed_send_https_gaps(sample), expected, "{sample}");
        }
        // A single-argument helper takes its only argument as the URL.
        let single = [
            (
                r#"async fn f() { if safe.scheme() != "https" { return Err("x".into()); } let request = build_request(safe); request.send().await?; }"#,
                (1, 0),
            ),
            (
                r#"async fn f() { if safe.scheme() != "https" { return Err("x".into()); } let request = build_request(evil); request.send().await?; }"#,
                (1, 1),
            ),
        ];
        for (sample, expected) in single {
            assert_eq!(credentialed_send_https_gaps(sample), expected, "{sample}");
        }
    }

    /// A wrapper that receives the credential-bearing builder owns it:
    /// `transmit(request)` is a dispatch bound to the builder's URL, even when
    /// a guarded `.send()` remains elsewhere (Codex PRRT_kwDOTwzAKs65txaL).
    #[test]
    fn codex_thread_wrapper_owning_builder_is_a_dispatch() {
        let unguarded = [
            (
                r#"async fn f() { let request = client.get(evil); transmit(request).await?; }"#,
                (1, 1),
            ),
            (
                r#"async fn f() { if safe.scheme() != "https" { return Err("x".into()); } let request = client.get(evil); transmit(request).await?; }"#,
                (1, 1),
            ),
        ];
        for (sample, expected) in unguarded {
            assert_eq!(credentialed_send_https_gaps(sample), expected, "{sample}");
        }
        let guarded = [
            (
                r#"async fn f() { if evil.scheme() != "https" { return Err("x".into()); } let request = client.get(evil); transmit(request).await?; }"#,
                (1, 0),
            ),
            (
                r#"async fn f() { let request = client.get(evil); transmit(client.get(safe)).await?; if safe.scheme() != "https" { return Err("x".into()); } }"#,
                (1, 1),
            ),
        ];
        for (sample, expected) in guarded {
            assert_eq!(credentialed_send_https_gaps(sample), expected, "{sample}");
        }
        // The wrapper send and the plain send both need their own guards.
        let both = r#"async fn f() { if safe.scheme() != "https" { return Err("x".into()); } let request = client.get(evil); request.send().await?; transmit(request).await?; }"#;
        assert_eq!(credentialed_send_https_gaps(both), (2, 2), "{both}");
        // Ordinary helpers that receive non-builder values are not dispatches.
        let ordinary = [
            r#"async fn f() { if parsed.scheme() != "https" { return Err("x".into()); } let tokens = open_tokens(&key); consume(&tokens); request.send().await?; }"#,
            r#"async fn f() { if parsed.scheme() != "https" { return Err("x".into()); } let body = json!({"key": name}); log(body); request.send().await?; }"#,
            r#"async fn f() { if parsed.scheme() != "https" { return Err("x".into()); } let url = format!("https://{host}/x"); describe(url); request.send().await?; }"#,
        ];
        for sample in ordinary {
            assert_eq!(credentialed_send_https_gaps(sample), (1, 0), "{sample}");
        }
    }

    /// `} else return;` never falls through: only the if-arm exit reaches the
    /// next statement, so the stale entry URL must not bless a send that the
    /// if-arm owns (Kimi council r2 chunk02 P1 — a braceless `else` left
    /// `pending_else` unconsumed).
    #[test]
    fn kimi_council_r2_braceless_else_return_keeps_if_exit() {
        let bless = r#"async fn f() { let request = client.get(url); if url.scheme() != "https" { return Err("x".into()); } if c1 { request = client.get(evil); } else return; request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(bless), (1, 1), "{bless}");
        let same = r#"async fn f() { let request = client.get(url); if url.scheme() != "https" { return Err("x".into()); } if c1 { request = client.get(url); } else return; request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(same), (1, 0), "{same}");
    }

    /// `myrequest` is not `request`. This probe proves the Kimi council r2
    /// chunk02 claim false on this code: `is_keyword_at` already enforces
    /// the leading ident boundary, so `note_binding` cannot match the send
    /// name inside a longer identifier and rebind it.
    #[test]
    fn kimi_council_r2_wider_ident_is_not_the_send_name() {
        let kept = r#"async fn f() { let request = client.get(url); if url.scheme() != "https" { return Err("x".into()); } myrequest = client.get(other); request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(kept), (1, 0), "{kept}");
    }

    /// A `;` inside a comment is not a statement break: the binding's RHS
    /// keeps the whole `if / else`, so disagreeing branch URLs still fail
    /// closed (Kimi council r2 chunk02 — `stmt_end` skips comments like its
    /// sibling scanners).
    #[test]
    fn kimi_council_r2_comment_semicolon_does_not_truncate_the_rhs() {
        let cases = [
            "fn f() { let request = if c { client.get(url) } // ;\n else { client.get(evil) }; request.send() }",
            "fn f() { let request = if c { client.get(url) } /* ; */ else { client.get(evil) }; request.send() }",
        ];
        for sample in cases {
            let open = sample.find('{').expect("fn body");
            let at = sample.find(".send").expect("send");
            assert_eq!(
                super::super::dispatch_url(sample, open, at).as_deref(),
                Some(""),
                "disagreeing branches must fail closed: {sample}"
            );
        }
    }
}
