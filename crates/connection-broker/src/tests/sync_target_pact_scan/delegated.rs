//! A tracked response passed by reference to a callee outside the allowlist.
//!
//! `drop` is the production discard. Every other free call that receives
//! `&response` or `&mut response` can read the provider body in another module,
//! which this single-file scan would otherwise miss. Outbound
//! `RequestBuilder::json(request, &body)` is exempt by callee: `&body` is the
//! serde payload slot, not a response borrow. The exemption is not a global
//! ignore of the name `body`.

use super::super::sync_target_pact_norm::string_len;
use super::super::sync_target_pact_rename::tracks_response_receiver;

const ALLOWED: &[&str] = &["drop"];

pub(super) fn passes_response_to_callee(scanned: &str, response_type_aliases: &[String]) -> bool {
    let bytes = scanned.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes[index] == b'(' && borrowed_response_call(scanned, index, response_type_aliases) {
            return true;
        }
        index += 1;
    }
    false
}

fn borrowed_response_call(scanned: &str, paren: usize, response_type_aliases: &[String]) -> bool {
    if !free_call(scanned, paren)
        || allowed_callee(callee_name(scanned, paren).as_str())
        || request_builder_json_call(scanned, paren, response_type_aliases)
    {
        return false;
    }
    args_borrow_response(scanned, paren)
}

fn request_builder_json_call(source: &str, paren: usize, response_type_aliases: &[String]) -> bool {
    let callee = callee_name(source, paren);
    if callee != "json" {
        return false;
    }
    let prefix = type_prefix_before_call(source, paren);
    if receiver_is_request(prefix) {
        return true;
    }
    let path = super::pattern::ufcs_type_path(prefix);
    if super::pattern::response_type_alias_path(path, response_type_aliases) {
        return false;
    }
    super::pattern::is_allowlisted_request_builder_path(path)
}

fn receiver_is_request(prefix: &str) -> bool {
    let trimmed = prefix.trim_end();
    let Some(rest) = trimmed.strip_suffix("request") else {
        return false;
    };
    rest.is_empty() || !super::is_ident_char(rest.chars().next_back().unwrap_or('\0'))
}

fn type_prefix_before_call(source: &str, paren: usize) -> &str {
    let Some((start, _)) = call_name_at(source, paren) else {
        return source[..paren].trim_end().trim_end_matches(':');
    };
    source[..start].trim_end().trim_end_matches(':')
}

fn allowed_callee(name: &str) -> bool {
    ALLOWED.contains(&name)
}

fn free_call(source: &str, paren: usize) -> bool {
    let Some((start, _)) = call_name_at(source, paren) else {
        return false;
    };
    start == 0 || source.as_bytes().get(start - 1) != Some(&b'.')
}

fn callee_name(source: &str, paren: usize) -> String {
    call_name_at(source, paren)
        .map(|(_, name)| name)
        .unwrap_or_default()
}

/// Ident of the callee, skipping a trailing turbofish (`helper::<T>(…)`).
fn call_name_at(source: &str, paren: usize) -> Option<(usize, String)> {
    let head = strip_turbofish_tail(source[..paren].trim_end());
    let name = super::ident_before(head);
    if name.is_empty() {
        return None;
    }
    Some((head.len() - name.len(), name))
}

fn strip_turbofish_tail(prefix: &str) -> &str {
    let trimmed = prefix.trim_end();
    let bytes = trimmed.as_bytes();
    if bytes.last() != Some(&b'>') {
        return trimmed;
    }
    let Some(lt) = matching_lt(bytes) else {
        return trimmed;
    };
    turbofish_before(trimmed, lt)
}

fn matching_lt(bytes: &[u8]) -> Option<usize> {
    let mut depth = 0i32;
    let mut index = bytes.len();
    while index > 0 {
        index -= 1;
        depth += i32::from(bytes[index] == b'>');
        if bytes[index] != b'<' {
            continue;
        }
        depth -= 1;
        if depth == 0 {
            return Some(index);
        }
    }
    None
}

fn turbofish_before(trimmed: &str, lt: usize) -> &str {
    let before = trimmed[..lt].trim_end();
    match before.strip_suffix("::") {
        Some(rest) => rest.trim_end(),
        None => trimmed,
    }
}

fn args_borrow_response(source: &str, paren: usize) -> bool {
    let bytes = source.as_bytes();
    let mut depth = 1i32;
    let mut index = paren + 1;
    let mut arg_start = index;
    while index < bytes.len() && depth > 0 {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth -= 1;
                if depth == 0 {
                    return arg_borrows(source, arg_start, index);
                }
            }
            b',' if depth == 1 => {
                if arg_borrows(source, arg_start, index) {
                    return true;
                }
                arg_start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    false
}

fn arg_borrows(source: &str, start: usize, end: usize) -> bool {
    let raw = &source[start..end];
    let arg = raw.trim();
    let Some(rest) = arg.strip_prefix('&') else {
        return false;
    };
    let rest = strip_mut(rest.trim_start());
    let rest = unwrap_parens(rest.trim());
    let name: String = rest
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
        .collect();
    if name.is_empty() || !rest[name.len()..].trim().is_empty() {
        return false;
    }
    let leading = raw.len() - raw.trim_start().len();
    let at = start + leading + arg.find(name.as_str()).unwrap_or(0);
    tracks_response_receiver(source, at, name)
}

fn strip_mut(rest: &str) -> &str {
    let Some(after) = rest.strip_prefix("mut") else {
        return rest;
    };
    if after
        .chars()
        .next()
        .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        return rest;
    }
    after.trim_start()
}

fn unwrap_parens(mut expr: &str) -> &str {
    while expr.starts_with('(') && expr.ends_with(')') && expr.len() >= 2 {
        expr = expr[1..expr.len() - 1].trim();
    }
    expr
}
