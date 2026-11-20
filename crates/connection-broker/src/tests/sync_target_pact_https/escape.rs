//! Free-call ownership escapes: a wrapper that receives the built request.
//!
//! `transmit(request).await?` hands the credential-bearing builder to a
//! callee this single-file scan cannot trace, so it counts as a dispatch
//! bound to that builder's URL.
use super::super::pattern::tuple_parts;
use super::super::{is_ident_byte, strip_turbofish};
use super::assigned_builder_url;
use super::bind_tail::{ident_prefix, stmt_end, strip_ref};
use super::url::{builder_url, call_inside, eq_after_name, has_builder_call, plain_receiver};
use crate::tests::sync_target_pact_norm::{is_keyword_at, non_code_len};

/// A free call that receives a locally built request owns it until proven
/// otherwise. An argument is an escape when it is a builder expression or a
/// name whose visible binding constructs a request (`client.get(…)` /
/// `self.http.request(…)`; a binding with no builder evidence is some other
/// value and does not make the call a dispatch). Returns the callee name
/// length and the resolved destination URL (empty when the builder marks
/// disagree, which fails closed like any bound dispatch).
pub(crate) fn ownership_escape(
    source: &str,
    fn_start: usize,
    at: usize,
) -> Option<(usize, String)> {
    let bytes = source.as_bytes();
    let rest = &source[at..];
    let name_len = ident_prefix(rest).len();
    if name_len == 0 {
        return None;
    }
    // Only the start of a callee name qualifies, and only for a plain free
    // call: methods (`request.json`), UFCS (`Type::method`), macros (`name!`),
    // and mid-identifier positions have their own paths or are not calls.
    if at > 0 && (is_ident_byte(bytes[at - 1]) || matches!(bytes[at - 1], b'.' | b':' | b'!')) {
        return None;
    }
    let name = &rest[..name_len];
    if matches!(
        name,
        "if" | "while"
            | "match"
            | "for"
            | "loop"
            | "return"
            | "move"
            | "async"
            | "await"
            | "fn"
            | "let"
            | "else"
            | "in"
            | "unsafe"
            | "const"
            | "static"
            | "use"
            | "mod"
            | "struct"
            | "enum"
            | "type"
            | "impl"
            | "where"
            | "pub"
            | "mut"
    ) {
        return None;
    }
    let mut tail = rest[name_len..].trim_start();
    tail = strip_turbofish(tail).unwrap_or(tail).trim_start();
    if !tail.starts_with('(') {
        return None;
    }
    let args = call_inside(tail)?;
    let prefix = &source[fn_start..at];
    for arg in tuple_parts(args) {
        if let Some(url) = escape_arg_url(prefix, arg) {
            return Some((name_len, url));
        }
    }
    None
}

fn escape_arg_url(prefix: &str, arg: &str) -> Option<String> {
    let stripped = strip_ref(arg.trim()).trim();
    // `transmit(client.get(evil))` passes the builder expression itself. The
    // builder heuristic also fires on unrelated one-argument calls
    // (`SyncTargetView::from(row)`), so the expression must show real builder
    // evidence, not just a call shape.
    if has_builder_call(stripped) {
        if let Some(url) = builder_url(stripped) {
            return Some(url.to_string());
        }
    }
    let name = plain_receiver(stripped)?;
    // A named argument is an escape only when its own binding constructs a
    // request. Bindings like `let tokens = open_tokens(…)` or `let body =
    // json!(…)` hold other values and must not turn an ordinary helper call
    // into a dispatch.
    if !binding_has_builder_evidence(prefix, name) {
        return None;
    }
    Some(assigned_builder_url(prefix, name).unwrap_or_default())
}

fn binding_has_builder_evidence(prefix: &str, name: &str) -> bool {
    let bytes = prefix.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        let Some(eq) = name_binding_eq(bytes, index, name) else {
            index += 1;
            continue;
        };
        let end = stmt_end(bytes, eq + 1);
        if has_builder_call(&prefix[eq + 1..end]) {
            return true;
        }
        index = end;
    }
    false
}

fn name_binding_eq(bytes: &[u8], index: usize, name: &str) -> Option<usize> {
    if !is_keyword_at(bytes, index, name.as_bytes()) {
        return None;
    }
    eq_after_name(bytes, index + name.len())
}
