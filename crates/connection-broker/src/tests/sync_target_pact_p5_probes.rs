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

fn redirect_policy_none_in_code(src: &str) -> bool {
    let src = strip_noise(src);
    let bytes = src.as_bytes();
    let mut saw_redirect = false;
    let mut saw_policy = false;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if src[index..].starts_with(".redirect(") {
            saw_redirect = true;
        }
        if src[index..].starts_with("Policy::none()") {
            saw_policy = true;
        }
        if saw_redirect && saw_policy {
            return true;
        }
        index += 1;
    }
    false
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
