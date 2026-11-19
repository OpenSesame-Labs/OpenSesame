//! HTTPS guard for credentialed sync dispatch.
//!
//! A dispatch is `.send` / `::send` / `.execute` / `::execute`, or a later call
//! through `let f = …::send`. The guarding `if` must `return` from that
//! function (not from a closure) when the dispatched URL is not https.
//! `&&` / `||` split before unary `!`. A guard on a different URL does not count.

mod bind;
mod guard;

use super::sync_target_pact_norm::string_len;

/// `(sends, missing)` for credentialed dispatch sites.
pub(crate) fn credentialed_send_https_gaps(source: &str) -> (usize, usize) {
    let source = super::sync_target_pact_norm::compact_source(
        &super::sync_target_pact_norm::strip_noise(source),
    );
    let bytes = source.as_bytes();
    let spans = super::sync_target_pact_norm::function_spans(bytes);
    let alias_calls = super::sync_target_pact_chain::dispatch_alias_calls(&source);
    let mut sends = 0usize;
    let mut missing = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if !source.is_char_boundary(index) {
            index += 1;
            continue;
        }
        if let Some(len) = dispatch_site(&source, &alias_calls, index) {
            if credentialed_dispatch_site(&source, index) {
                sends += 1;
                if !scheme_guarded(&source, &spans, index) {
                    missing += 1;
                }
            }
            index += len;
            continue;
        }
        index += 1;
    }
    (sends, missing)
}

fn credentialed_dispatch_site(source: &str, index: usize) -> bool {
    let rest = &source[index..];
    if !rest.starts_with(".execute") {
        return true;
    }
    let name: String = source[..index]
        .trim_end()
        .chars()
        .rev()
        .take_while(|ch| is_ident_char(*ch))
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    matches!(name.as_str(), "client" | "request" | "req" | "builder" | "http")
}

fn dispatch_site(source: &str, alias_calls: &[(usize, usize)], index: usize) -> Option<usize> {
    dispatch_len(&source[index..]).or_else(|| {
        alias_calls
            .iter()
            .find(|(at, _)| *at == index)
            .map(|(_, len)| *len)
    })
}

fn scheme_guarded(source: &str, spans: &[(usize, usize)], index: usize) -> bool {
    let Some((start, _)) = spans
        .iter()
        .copied()
        .filter(|(span_start, end)| *span_start < index && index < *end)
        .min_by_key(|(span_start, end)| end - span_start)
    else {
        return false;
    };
    let dest = bind::dispatch_url(source, start, index);
    guard::guarded(&source[start..index], dest.as_deref())
}

/// `.send(` / `::send(` / `.execute(` / `::execute(`, optional turbofish.
fn dispatch_len(rest: &str) -> Option<usize> {
    const HEADS: &[&str] = &["::execute", "::send", ".execute", ".send"];
    let head = HEADS.iter().copied().find(|head| rest.starts_with(head))?;
    let after = &rest[head.len()..];
    let after = strip_turbofish(after).unwrap_or(after);
    after.starts_with('(').then_some(head.len())
}

pub(super) fn strip_turbofish(after: &str) -> Option<&str> {
    let after = after.strip_prefix("::")?.strip_prefix('<')?;
    let mut depth = 1i32;
    for (index, ch) in after.char_indices() {
        match ch {
            '<' => depth += 1,
            '>' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&after[index + ch.len_utf8()..]);
                }
            }
            _ => {}
        }
    }
    None
}

pub(super) fn after_paren(source: &str) -> Option<&str> {
    let bytes = source.as_bytes();
    let mut depth = 1i32;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&source[index + 1..]);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

pub(super) fn ident_at(bytes: &[u8], index: usize, ident: &[u8]) -> bool {
    let end = index + ident.len();
    end <= bytes.len()
        && &bytes[index..end] == ident
        && (index == 0 || !is_ident_byte(bytes[index - 1]))
        && (end == bytes.len() || !is_ident_byte(bytes[end]))
}

pub(super) fn is_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

pub(super) fn is_ident_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

#[cfg(test)]
mod dispatch_tests {
    use super::credentialed_send_https_gaps;
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
        let raw =
            "async fn f() { let _ = r#\"parsed.scheme() != \"https\"#; request.send().await?; }";
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
        let db = "async fn f() { query.execute(&self.pool).await?; }";
        assert_eq!(credentialed_send_https_gaps(db), (0, 0));
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
        let logical = "async fn f() { if parsed.scheme() != \"https\" { let x = flag || return Err(\"x\".into()); } request.send().await?; }";
        assert_eq!(credentialed_send_https_gaps(logical), (1, 0));
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
}
