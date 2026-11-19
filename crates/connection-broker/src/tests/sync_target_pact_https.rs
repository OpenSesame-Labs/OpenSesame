//! HTTPS guard for credentialed sync dispatch.
//!
//! A dispatch is a call (`.send(…)`, `::send(…)`, `.execute(…)`, `::execute(…)`)
//! or a later call through `let f = …::send` / `let f = Client::execute`.
//! Each site must sit after an `if` in the same function whose condition is
//! true for non-https (`scheme() != "https"` or `.ne("https")`). `!` flips
//! that term and binds tighter than `&&` / `||`. The body must `return`.
//! A bare comparison, `assert!`, and the error text are not that guard.

use super::sync_target_pact_norm::{compact_source, is_keyword_at, string_len, strip_noise};

/// `(sends, missing)` for credentialed dispatch sites.
pub(crate) fn credentialed_send_https_gaps(source: &str) -> (usize, usize) {
    let source = compact_source(&strip_noise(source));
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
            sends += 1;
            if !scheme_guarded(&source, &spans, index) {
                missing += 1;
            }
            index += len;
            continue;
        }
        index += 1;
    }
    (sends, missing)
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
    spans
        .iter()
        .copied()
        .filter(|(start, end)| *start < index && index < *end)
        .min_by_key(|(start, end)| end - start)
        .is_some_and(|(start, _)| https_scheme_guard(&source[start..index]))
}
/// `.send(` / `::send(` / `.execute(` / `::execute(`, optional turbofish.
fn dispatch_len(rest: &str) -> Option<usize> {
    const HEADS: &[&str] = &["::execute", "::send", ".execute", ".send"];
    let head = HEADS.iter().copied().find(|head| rest.starts_with(head))?;
    let after = &rest[head.len()..];
    let after = strip_turbofish(after).unwrap_or(after);
    after.starts_with('(').then_some(head.len())
}
fn https_scheme_guard(prefix: &str) -> bool {
    let bytes = prefix.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if is_keyword_at(bytes, index, b"if") && if_rejects_non_https(prefix, index) {
            return true;
        }
        index += 1;
    }
    false
}
/// `if scheme() != "https" { return … }`. Negated `!(scheme() != "https")` does not.
fn if_rejects_non_https(prefix: &str, if_at: usize) -> bool {
    let bytes = prefix.as_bytes();
    let cond_from = if_at + 2;
    let Some(open) = condition_brace(bytes, cond_from) else {
        return false;
    };
    if !fails_closed(&prefix[cond_from..open], false) {
        return false;
    }
    let Some(close) = super::sync_target_pact_norm::match_brace(bytes, open) else {
        return false;
    };
    depth0_return(&prefix[open + 1..close])
}

fn fails_closed(expr: &str, negated: bool) -> bool {
    let expr = peel(expr);
    // `||` / `&&` bind looser than unary `!`, so split them before flipping.
    if let Some((left, right)) = split_top(expr, "||") {
        let (lhs, rhs) = (fails_closed(left, negated), fails_closed(right, negated));
        return if negated { lhs && rhs } else { lhs || rhs };
    }
    if let Some((left, right)) = split_top(expr, "&&") {
        let (lhs, rhs) = (fails_closed(left, negated), fails_closed(right, negated));
        return if negated { lhs || rhs } else { lhs && rhs };
    }
    if expr.starts_with('!') && !expr.starts_with("!=") {
        return fails_closed(peel(&expr[1..]), !negated);
    }
    !negated && whole_scheme_neq(expr)
}
fn peel(expr: &str) -> &str {
    if let Some(rest) = expr.strip_prefix('(') {
        if let Some(after) = after_paren(rest) {
            if after.is_empty() {
                return peel(&expr[1..expr.len() - 1]);
            }
        }
    }
    expr
}
fn split_top<'a>(expr: &'a str, op: &str) -> Option<(&'a str, &'a str)> {
    let bytes = expr.as_bytes();
    let mut index = 0usize;
    let mut depth = 0i32;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        depth += match bytes[index] {
            b'(' | b'[' | b'{' => 1,
            b')' | b']' | b'}' => -1,
            _ => 0,
        };
        if depth == 0 && expr[index..].starts_with(op) {
            return Some((&expr[..index], &expr[index + op.len()..]));
        }
        index += 1;
    }
    None
}
fn whole_scheme_neq(expr: &str) -> bool {
    let bytes = expr.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if let Some(end) = scheme_neq_end(expr, index) {
            let prefix = &expr[..index];
            return end == expr.len() && !prefix.bytes().any(|b| matches!(b, b'!' | b'&' | b'|'));
        }
        index += 1;
    }
    false
}
fn condition_brace(bytes: &[u8], from: usize) -> Option<usize> {
    let mut paren = 0i32;
    let mut index = from;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' => paren += 1,
            b')' => paren -= 1,
            b'{' if paren == 0 => return Some(index),
            b';' if paren == 0 => return None,
            _ => {}
        }
        index += 1;
    }
    None
}
fn depth0_return(body: &str) -> bool {
    let bytes = body.as_bytes();
    let mut depth = 0i32;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            _ if depth == 0 && is_keyword_at(bytes, index, b"return") => return true,
            _ => {}
        }
        index += 1;
    }
    false
}

fn scheme_neq_end(source: &str, index: usize) -> Option<usize> {
    if !ident_at(source.as_bytes(), index, b"scheme") {
        return None;
    }
    let mut rest = &source[index + "scheme".len()..];
    if let Some(stripped) = strip_turbofish(rest) {
        rest = stripped;
    }
    rest = rest.strip_prefix('(')?;
    rest = after_paren(rest)?;
    let trimmed = rest.trim_start_matches(')');
    let extra = rest.len() - trimmed.len();
    let consumed = https_cmp_len(trimmed)?;
    Some(source.len() - rest.len() + extra + consumed)
}
fn https_cmp_len(tail: &str) -> Option<usize> {
    let rest = tail
        .strip_prefix("!=")
        .or_else(|| tail.strip_prefix(".ne"))?;
    let op = tail.len() - rest.len();
    let body = rest.trim_start_matches('(');
    if !body.starts_with("\"https\"") {
        return None;
    }
    let mut end = op + (rest.len() - body.len()) + "\"https\"".len();
    let mut open = rest.len() - body.len();
    while open > 0 && tail.as_bytes().get(end) == Some(&b')') {
        end += 1;
        open -= 1;
    }
    Some(end)
}
fn ident_at(bytes: &[u8], index: usize, ident: &[u8]) -> bool {
    let end = index + ident.len();
    end <= bytes.len()
        && &bytes[index..end] == ident
        && (index == 0 || !is_ident_byte(bytes[index - 1]))
        && (end == bytes.len() || !is_ident_byte(bytes[end]))
}
fn after_paren(source: &str) -> Option<&str> {
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
fn strip_turbofish(after: &str) -> Option<&str> {
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
fn is_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
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
}
