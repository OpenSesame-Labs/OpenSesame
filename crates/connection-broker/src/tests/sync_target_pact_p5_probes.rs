//! Host pin, redirect policy, and stream-receiver probes.
use super::super::sync_target_pact_https::credentialed_send_https_gaps;
use super::super::sync_target_pact_norm::{
    function_spans, is_keyword_at, match_brace, non_code_len, strip_noise,
};
use super::super::sync_target_pact_scan::sync_target_production_for_scan;
use super::{assert_clear, assert_read};

#[test]
fn p5_redirect_policy_none_in_egress_clients() {
    assert!(
        egress_sources_disable_redirects(),
        "credentialed egress client must disable redirects"
    );
    let commented = "// .redirect(redirect::Policy::none())\nfn f() {}\n";
    assert!(!redirect_policy_none_in_code(commented));
    let quoted = "fn f() { let _ = \".redirect(redirect::Policy::none())\"; }\n";
    assert!(!redirect_policy_none_in_code(quoted));
    let unrelated = [
        "fn f() { client.redirect(redirect::Policy::limited(10)); }\nfn g() { let _ = Policy::none(); }\n",
        "fn f() { builder.redirect(Policy::none()); other.redirect(Policy::limited(1)); }\n",
        "fn f() { builder.redirect(wrap(Policy::none())); }\n",
    ];
    for sample in unrelated {
        assert!(!redirect_policy_none_in_code(sample), "{sample}");
    }
    let configured = [
        "fn f() { builder.redirect(reqwest::redirect::Policy::none()); }\n",
        "fn f() { builder.redirect(redirect::Policy::none()); }\n",
        "fn f() { builder.redirect(Policy::none()); }\n",
    ];
    for sample in configured {
        assert!(redirect_policy_none_in_code(sample), "{sample}");
    }
}

pub(crate) fn egress_sources_disable_redirects() -> bool {
    [
        include_str!("../lib.rs"),
        include_str!("../constructor.rs"),
        include_str!("../egress_client.rs"),
    ]
    .into_iter()
    .all(redirect_policy_none_in_code)
}

/// Every `.redirect(` configures the client with `Policy::none()`.
/// A `Policy::none()` elsewhere in the file does not count.
fn redirect_policy_none_in_code(src: &str) -> bool {
    let src = strip_noise(src);
    let bytes = src.as_bytes();
    let mut index = 0usize;
    let mut saw = false;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if src[index..].starts_with(".redirect(") {
            let open = index + ".redirect".len();
            let Some(arg) = paren_inside(&src[open..]) else {
                return false;
            };
            if !arg_is_policy_none(arg) {
                return false;
            }
            saw = true;
            index = open + 1;
            continue;
        }
        index += 1;
    }
    saw
}

fn arg_is_policy_none(arg: &str) -> bool {
    let compact = code_compact(arg);
    let Some(at) = policy_none_at(&compact) else {
        return false;
    };
    let before = &compact[..at];
    let after = &compact[at + "Policy::none()".len()..];
    after.is_empty() && (before.is_empty() || before.ends_with("::"))
}

fn policy_none_at(compact: &str) -> Option<usize> {
    let needle = "Policy::none()";
    let mut offset = 0usize;
    while let Some(rel) = compact[offset..].find(needle) {
        let at = offset + rel;
        let boundary = at == 0 || compact.as_bytes()[at - 1] == b':';
        if boundary {
            return Some(at);
        }
        offset = at + needle.len();
    }
    None
}

fn code_compact(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = String::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if !bytes[index].is_ascii_whitespace() {
            out.push(bytes[index] as char);
        }
        index += 1;
    }
    out
}

fn paren_inside(at_paren: &str) -> Option<&str> {
    let bytes = at_paren.strip_prefix('(')?.as_bytes();
    let mut depth = 1i32;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&at_paren[1..index + 1]);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

/// Every `.send()` sits in a function whose depth-1 `if` is
/// `parsed.host_str() != Some(authority)` and returns before that send.
/// A nested `fn`, a nested block, `else if`, or two separate mentions do not.
fn host_pin_guards_send(source: &str) -> bool {
    let source = strip_noise(source);
    let sends = send_calls(&source);
    if sends.is_empty() {
        return false;
    }
    let spans = function_spans(source.as_bytes());
    sends.into_iter().all(|send| {
        let Some((start, end)) = spans
            .iter()
            .copied()
            .filter(|(span_start, span_end)| *span_start < send && send < *span_end)
            .min_by_key(|(span_start, span_end)| span_end - span_start)
        else {
            return false;
        };
        host_pin_dominates(&source[start..=end], send - start)
    })
}

fn send_calls(source: &str) -> Vec<usize> {
    let bytes = source.as_bytes();
    let needle = b".send()";
    let mut index = 0usize;
    let mut found = Vec::new();
    while index + needle.len() <= bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes[index..].starts_with(needle) {
            found.push(index);
            index += needle.len();
            continue;
        }
        index += 1;
    }
    found
}

fn host_pin_dominates(func: &str, send_rel: usize) -> bool {
    let bytes = func.as_bytes();
    let mut index = 0usize;
    let mut depth = 0i32;
    while index < send_rel && index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' => depth += 1,
            b'}' if depth > 0 => depth -= 1,
            _ => {}
        }
        if depth == 1 && is_keyword_at(bytes, index, b"if") && host_pin_if(func, index, send_rel) {
            return true;
        }
        index += 1;
    }
    false
}

fn host_pin_if(func: &str, if_at: usize, send_at: usize) -> bool {
    let bytes = func.as_bytes();
    if preceded_by_else(bytes, if_at) {
        return false;
    }
    let Some(open) = condition_open(bytes, if_at + 2) else {
        return false;
    };
    if open >= send_at || !host_pin_condition(&func[if_at + 2..open]) {
        return false;
    }
    let Some(close) = match_brace(bytes, open) else {
        return false;
    };
    close < send_at && if_body_returns(&func[open + 1..close])
}

fn preceded_by_else(bytes: &[u8], index: usize) -> bool {
    let mut at = index;
    while at > 0 && bytes[at - 1].is_ascii_whitespace() {
        at -= 1;
    }
    at >= 4 && is_keyword_at(bytes, at - 4, b"else")
}

fn condition_open(bytes: &[u8], from: usize) -> Option<usize> {
    let mut paren = 0i32;
    let mut index = from;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' => paren += 1,
            b')' if paren > 0 => paren -= 1,
            b'{' if paren == 0 => return Some(index),
            b';' if paren == 0 => return None,
            _ => {}
        }
        index += 1;
    }
    None
}

fn host_pin_condition(cond: &str) -> bool {
    let compact = code_compact(cond.trim());
    peel_wrapping_parens(&compact) == "parsed.host_str()!=Some(authority)"
}

fn peel_wrapping_parens(expr: &str) -> &str {
    let mut expr = expr;
    while expr.len() >= 2 && expr.starts_with('(') && expr.ends_with(')') && wraps_all(expr) {
        expr = &expr[1..expr.len() - 1];
    }
    expr
}

fn wraps_all(expr: &str) -> bool {
    let bytes = expr.as_bytes();
    let mut depth = 0i32;
    for (index, byte) in bytes.iter().enumerate() {
        match byte {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return index + 1 == bytes.len();
                }
            }
            _ => {}
        }
    }
    false
}

fn if_body_returns(body: &str) -> bool {
    let bytes = body.as_bytes();
    let mut depth = 0i32;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' | b'(' | b'[' => depth += 1,
            b'}' | b')' | b']' if depth > 0 => depth -= 1,
            _ if depth == 0 && is_keyword_at(bytes, index, b"return") => return true,
            _ => {}
        }
        index += 1;
    }
    false
}

#[test]
fn p5_host_str_authority_pin_precedes_send() {
    let production = sync_target_production_for_scan(include_str!("../sync_target.rs"));
    assert!(
        host_pin_guards_send(&production),
        "production send must pin host_str to the authority in that function"
    );
    let (sends, missing) = credentialed_send_https_gaps(&production);
    assert!(sends >= 1, "credentialed sync must send");
    assert_eq!(missing, 0, "unguarded credentialed sends: {missing}");
}

#[test]
fn council_p1_host_pin_dominates_every_send() {
    let nested = "async fn f() { fn pin() { if parsed.host_str() != Some(authority) { return Err(\"x\".into()); } } request.send().await?; }";
    assert!(
        !host_pin_guards_send(nested),
        "a pin inside a nested fn does not cover the outer send: {nested}"
    );
    let split = "async fn f() { let _ = parsed.host_str(); if flag != Some(authority) { return Err(\"x\".into()); } request.send().await?; }";
    assert!(
        !host_pin_guards_send(split),
        "separate mentions are not one host pin: {split}"
    );
    let buried = "async fn f() { if ready { if parsed.host_str() != Some(authority) { return Err(\"x\".into()); } } request.send().await?; }";
    assert!(
        !host_pin_guards_send(buried),
        "a nested if does not dominate the send: {buried}"
    );
    let later = "async fn kept() { if parsed.host_str() != Some(authority) { return Err(\"x\".into()); } request.send().await?; } async fn extra() { other.send().await?; }";
    assert!(
        !host_pin_guards_send(later),
        "a later send in another function still needs the pin: {later}"
    );
    let no_return = "async fn f() { if parsed.host_str() != Some(authority) { let _ = 1; } request.send().await?; }";
    assert!(
        !host_pin_guards_send(no_return),
        "the pin must return before the send: {no_return}"
    );
    let else_if = "async fn f() { if ready {} else if parsed.host_str() != Some(authority) { return Err(\"x\".into()); } request.send().await?; }";
    assert!(
        !host_pin_guards_send(else_if),
        "else if does not dominate the send: {else_if}"
    );
    let both = "async fn f() { if parsed.host_str() != Some(authority) { return Err(\"x\".into()); } request.send().await?; other.send().await?; }";
    assert!(
        host_pin_guards_send(both),
        "one dominating pin covers every later send in that function: {both}"
    );
}

#[test]
fn p5_host_pin_ignores_comments_strings_and_other_functions() {
    let comment =
        "async fn f() { // parsed.host_str() != Some(authority)\n request.send().await?; }";
    assert!(!host_pin_guards_send(comment), "{comment}");
    let quoted = r#"async fn f() { let _ = "parsed.host_str() != Some(authority)"; request.send().await?; }"#;
    assert!(!host_pin_guards_send(quoted), "{quoted}");
    let other = "fn pin() { if parsed.host_str() != Some(authority) {} } async fn f() { request.send().await?; }";
    assert!(!host_pin_guards_send(other), "{other}");
    let live = r#"async fn f() { if parsed.host_str() != Some(authority) { return Err("x".into()); } request.send().await?; }"#;
    assert!(host_pin_guards_send(live), "{live}");
}

#[test]
fn p5_unrelated_stream_markers_are_not_body_reads() {
    for sample in [
        "entries.iter().for_each(|entry| process(entry))",
        "rows.for_each(|row| process(row))",
        "entries.iter().try_fold(0, |a, _| Ok::<_, ()>(a))",
        "StreamExt::for_each(rows, |_| async {})",
        "TryStreamExt::try_collect(rows)",
    ] {
        assert_clear(sample);
    }
    for sample in [
        "http_response.for_each(|_| async {})",
        "StreamExt::for_each(response, |_| async {})",
        "response.try_next().await?",
        "TryStreamExt::try_collect(response)",
        "body.try_collect()",
        "StreamExt::count(&mut response)",
        "StreamExt::count::<usize>(&mut response)",
        "futures::StreamExt::next(&mut response).await",
    ] {
        assert_read(sample);
    }
}
