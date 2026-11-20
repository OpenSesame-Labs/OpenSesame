//! Host pin, redirect policy, and stream-receiver probes.
use super::super::sync_target_pact_https::credentialed_send_https_gaps;
use super::super::sync_target_pact_norm::{function_spans, non_code_len, strip_noise};
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

fn code_find(hay: &str, needle: &str) -> Option<usize> {
    let bytes = hay.as_bytes();
    let needle = needle.as_bytes();
    let mut index = 0usize;
    while index + needle.len() <= bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if &bytes[index..index + needle.len()] == needle {
            return Some(index);
        }
        index += 1;
    }
    None
}

/// `parsed.host_str() != Some(authority)` in the same function, before `.send()`.
fn host_pin_guards_send(source: &str) -> bool {
    let source = strip_noise(source);
    let Some(send) = code_find(&source, ".send()") else {
        return false;
    };
    let bytes = source.as_bytes();
    let Some((start, _)) = function_spans(bytes)
        .into_iter()
        .filter(|(span_start, end)| *span_start < send && send < *end)
        .min_by_key(|(span_start, end)| end - span_start)
    else {
        return false;
    };
    let body = &source[start..send];
    code_find(body, "parsed.host_str()").is_some()
        && code_find(body, "!= Some(authority)").is_some()
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
