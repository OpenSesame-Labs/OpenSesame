//! Host pin and stream-receiver probes.
use super::super::sync_target_pact_https::{closure_owns, credentialed_send_https_gaps};
use super::super::sync_target_pact_norm::{
    function_spans, is_keyword_at, match_brace, non_code_len, strip_noise,
};
use super::super::sync_target_pact_scan::sync_target_production_for_scan;
use super::redirect::code_compact;
use super::{assert_clear, assert_read};

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
    let mut stmt = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' | b'(' | b'[' => depth += 1,
            b'}' | b')' | b']' if depth > 0 => depth -= 1,
            b';' if depth == 0 => stmt = index + 1,
            // `|| return` and `|x| return` leave the closure, not the pin.
            _ if depth == 0 && is_keyword_at(bytes, index, b"return") => {
                if !closure_owns(&body[stmt..index]) {
                    return true;
                }
            }
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
fn council_r3_closure_return_and_raw_return_do_not_pin() {
    let open = [
        r#"async fn f() { if parsed.host_str() != Some(authority) { || return Err("x".into()); } request.send().await?; }"#,
        r#"async fn f() { if parsed.host_str() != Some(authority) { let _ = || return Err("x".into()); } request.send().await?; }"#,
        r#"async fn f() { if parsed.host_str() != Some(authority) { move |x| return Err(x); } request.send().await?; }"#,
        r#"async fn f() { if parsed.host_str() != Some(authority) { |x| x > 0 || return Err("x".into()); } request.send().await?; }"#,
        r#"async fn f() { if parsed.host_str() != Some(authority) { let r#return = 1; } request.send().await?; }"#,
    ];
    for sample in open {
        assert!(
            !host_pin_guards_send(sample),
            "closure or raw ident must not count as the pin returning: {sample}"
        );
    }
    let kept = [
        r#"async fn f() { if parsed.host_str() != Some(authority) { return Err("x".into()); } request.send().await?; }"#,
        r#"async fn f() { if parsed.host_str() != Some(authority) { let _ = || 1; return Err("x".into()); } request.send().await?; }"#,
        r#"async fn f() { if parsed.host_str() != Some(authority) { flag || return Err("x".into()); } request.send().await?; }"#,
    ];
    for sample in kept {
        assert!(
            host_pin_guards_send(sample),
            "a real return still pins the send: {sample}"
        );
    }
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

/// The host pin is verified structurally: comment or string decoys that quote
/// `parsed.host_str() != Some(authority)` do not count, and two separate
/// fragment mentions do not add up to the comparison (Codex
/// PRRT_kwDOTwzAKs65srXs, PRRT_kwDOTwzAKs65tGUb, PRRT_kwDOTwzAKs65wAMT).
#[test]
fn codex_thread_host_pin_structural_match() {
    let decoys = [
        "async fn f() { // parsed.host_str() != Some(authority)\n request.send().await?; }",
        r#"async fn f() { let _ = "parsed.host_str() != Some(authority)"; request.send().await?; }"#,
        "async fn f() { let _ = parsed.host_str(); if candidate != Some(authority) { return Err(\"x\".into()); } request.send().await?; }",
        "async fn f() { let _ = parsed.host_str(); let _ = authority; if candidate != Some(other) { return Err(\"x\".into()); } request.send().await?; }",
    ];
    for sample in decoys {
        assert!(
            !host_pin_guards_send(sample),
            "comment, string, or split fragments are not the pin: {sample}"
        );
    }
    let pinned = r#"async fn f() { if parsed.host_str() != Some(authority) { return Err("x".into()); } request.send().await?; }"#;
    assert!(
        host_pin_guards_send(pinned),
        "the complete comparison pins the send: {pinned}"
    );
}
