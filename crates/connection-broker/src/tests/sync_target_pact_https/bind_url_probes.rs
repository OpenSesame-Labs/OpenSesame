use super::{builder_url, has_builder_call};

/// `marked_url` and `has_builder_call` skip comment regions via
/// `non_code_len`, like `call_arg_url` and the guard modules: a
    /// commented-out `.get(evil)` must not lend builder URL evidence
    /// (Kimi council chunk03 P2).
    #[test]
    fn kimi_council_r2_commented_builder_call_lends_no_url_evidence() {
        for expr in [
            "/* client.get(evil) */ client.get(url)",
            "client.get(url) // .get(evil)",
            "client.get(url) /* .post(evil) */",
            "// client.get(evil)\nclient.get(url)",
        ] {
            assert_eq!(builder_url(expr), Some("url"), "{expr}");
        }
        for expr in ["/* client.get(evil) */", "// client.get(evil)"] {
            assert_eq!(builder_url(expr), None, "{expr}");
        }
        // A real free-call mark stands; the trailing commented `.get(evil)`
        // must not disagree with it.
        assert_eq!(builder_url("make(url) /* client.get(evil) */"), Some("url"));
        assert!(!has_builder_call("/* client.get(evil) */ make()"));
        assert!(!has_builder_call("// client.get(evil)\nmake()"));
        assert!(has_builder_call("client.get(url)"));
        // A string literal is still not code.
        assert!(!has_builder_call("let _ = \"client.get(url)\";"));
    }

    /// UFCS one-arg calls and parenthesized keyword conditions do not choose
    /// the binding's URL (Kimi council chunk03 P2). `Type::from(row)` or
    /// `if (url)` marking their argument would bind a wrong URL name, so a
    /// coincidental scheme guard on that name could cover an unrelated send.
    #[test]
    fn kimi_council_chunk03_ufcs_and_keyword_paren_calls_do_not_mark_url() {
        for expr in [
            "SyncTargetView::from(row)",
            "Wrapper::new(row)",
            "if (url) { a } else { b }",
            "while (url) { a }",
            "match (url) { _ => a }",
        ] {
            assert_eq!(builder_url(expr), None, "{expr}");
        }
        // Controls: a free one-arg call and a builder method still mark.
        assert_eq!(builder_url("build_request(other)"), Some("other"));
        assert_eq!(builder_url("client.get(url)"), Some("url"));
    }

    /// A turbofish'd free call still marks the binding URL (Kimi council
    /// chunk03 P2): `build_request::<T>(url)` resolves like the plain free
    /// call; UFCS and keyword shapes stay excluded.
    #[test]
    fn kimi_council_r3_turbofish_free_call_marks_binding_url() {
        for (expr, want) in [
            ("build_request::<T>(url)", Some("url")),
            ("build_request::<Vec<T>>(url)", Some("url")),
            ("build_request::<{1 > 0}>(url)", Some("url")),
            ("make(url)", Some("url")),
            ("Wrapper::new::<T>(row)", None),
            ("if (url) { a } else { b }", None),
            ("foo!(url)", None),
        ] {
            assert_eq!(builder_url(expr), want, "{expr}");
        }
    }

    /// The `::` separator arm must apply the same uppercase-type-segment
    /// exclusion as `is_free_call` / `escape.rs`: UFCS `Cache::get(url)` names
    /// an associated function, not a request builder, so marking its argument
    /// would fabricate URL provenance a coincidental scheme guard could cover
    /// (Kimi council chunk03 P2).
    #[test]
    fn kimi_council_r4_ufcs_type_get_is_not_a_builder_mark() {
        for expr in [
            "Cache::get(url)",
            "Wrapper::get(request)",
            "Cache::get::<T>(url)",
            "Cache::post(url)",
            "Cache::delete(url)",
        ] {
            assert_eq!(builder_url(expr), None, "{expr}");
            assert!(!has_builder_call(expr), "{expr}");
        }
        // Controls: a lowercase module path is a free builder function, and a
        // method receiver still marks.
        assert_eq!(builder_url("reqwest::get(url)"), Some("url"));
        assert_eq!(builder_url("client.get(url)"), Some("url"));
        assert_eq!(builder_url("client.post(url)"), Some("url"));
    }
