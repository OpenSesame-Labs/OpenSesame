//! Expression peeling and receiver names.
use super::super::sync_target_pact_norm::string_len;
use super::bind::{plain_name, read_ident_at};
use super::marker::is_ident_char;

pub(super) fn receiver_before(source: &str, dot: usize) -> String {
    let mut prefix = source[..dot].trim_end();
    for _ in 0..8 {
        if !prefix.ends_with(')') {
            break;
        }
        let Some(open) = matching_open(prefix, prefix.len() - 1) else {
            break;
        };
        let prev = prefix[..open].trim_end();
        // `response.clone()` / `response.by_ref()` — the outer call's receiver
        // is the method receiver, not the empty span after `)`.
        if let Some(recv) = method_receiver(prev) {
            prefix = recv.trim_end();
            continue;
        }
        // `foo(response)` is a call. A grouping paren peels inward.
        if preceded_by_call(prev) {
            break;
        }
        let inner = prefix[open + 1..prefix.len() - 1].trim();
        if let Some(name) = plain_name(inner) {
            return name;
        }
        if inner.len() >= prefix.len() {
            break;
        }
        prefix = inner;
    }
    trailing_ident(prefix).unwrap_or_default()
}

fn method_receiver(prev: &str) -> Option<&str> {
    let head = strip_trailing_turbofish(prev);
    let dot = head.rfind('.')?;
    let name = &head[dot + 1..];
    if name.is_empty() || !name.chars().all(is_ident_char) {
        return None;
    }
    let recv = head[..dot].trim_end();
    (!recv.is_empty()).then_some(recv)
}

fn strip_trailing_turbofish(prev: &str) -> &str {
    let trimmed = prev.trim_end();
    let bytes = trimmed.as_bytes();
    if bytes.last() != Some(&b'>') {
        return trimmed;
    }
    let mut depth = 0i32;
    let mut index = bytes.len();
    while index > 0 {
        index -= 1;
        match bytes[index] {
            b'>' => depth += 1,
            b'<' => {
                depth -= 1;
                if depth == 0 {
                    let before = trimmed[..index].trim_end();
                    return before.strip_suffix("::").unwrap_or(trimmed);
                }
            }
            _ => {}
        }
    }
    trimmed
}

fn preceded_by_call(prev: &str) -> bool {
    prev.ends_with(|ch: char| is_ident_char(ch) || ch == '.')
}

pub(super) fn unwrap_value(expr: &str) -> &str {
    let mut expr = expr.trim();
    for _ in 0..4 {
        let next = peel_block(unwrap_parens(expr)).trim();
        if next.len() == expr.len() {
            break;
        }
        expr = next;
    }
    expr
}

fn peel_block(expr: &str) -> &str {
    if !expr.starts_with('{') {
        return expr;
    }
    let Some(close) = match_delim(expr, b'{', b'}') else {
        return expr;
    };
    let after = expr[close + 1..].trim_start();
    if !(after.is_empty() || matches!(after.chars().next(), Some(';' | '.' | ')' | ',' | ']'))) {
        return expr;
    }
    stmt_tail(&expr[1..close])
}

fn stmt_tail(inner: &str) -> &str {
    let bytes = inner.as_bytes();
    let (mut depth, mut index, mut semi) = (0i32, 0usize, 0usize);
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' | b'(' | b'[' => depth += 1,
            b'}' | b')' | b']' if depth > 0 => depth -= 1,
            b';' if depth == 0 => semi = index + 1,
            _ => {}
        }
        index += 1;
    }
    inner[semi..].trim()
}

pub(super) fn strip_ref(expr: &str) -> &str {
    let mut expr = expr.trim_start();
    for _ in 0..4 {
        if let Some(rest) = expr.strip_prefix("&mut") {
            if rest.chars().next().is_none_or(|ch| !is_ident_char(ch)) {
                expr = rest.trim_start();
                continue;
            }
        }
        if let Some(rest) = expr.strip_prefix('&') {
            expr = rest.trim_start();
            continue;
        }
        break;
    }
    expr
}

pub(super) fn unwrap_parens(expr: &str) -> &str {
    let mut expr = expr.trim();
    while expr.starts_with('(') {
        let Some(close) = match_delim(expr, b'(', b')') else {
            break;
        };
        let after = expr[close + 1..].trim_start();
        if !(after.is_empty() || matches!(after.chars().next(), Some(';' | '.' | ')'))) {
            break;
        }
        expr = expr[1..close].trim();
    }
    expr
}

pub(super) fn match_delim(expr: &str, open_b: u8, close_b: u8) -> Option<usize> {
    let bytes = expr.as_bytes();
    if bytes.first() != Some(&open_b) {
        return None;
    }
    let (mut depth, mut index) = (0i32, 0usize);
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes[index] == open_b {
            depth += 1;
        } else if bytes[index] == close_b {
            depth -= 1;
            if depth == 0 {
                return Some(index);
            }
        }
        index += 1;
    }
    None
}

pub(super) fn matching_open(source: &str, close: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    if close >= bytes.len() || bytes[close] != b')' {
        return None;
    }
    let mut stack = Vec::new();
    let mut index = 0usize;
    while index <= close {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' => stack.push(index),
            b')' => {
                let open = stack.pop()?;
                if index == close {
                    return Some(open);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

#[cfg(test)]
mod probes {
    use crate::tests::sync_target_pact_scan::response_body_reads;

    fn reads(sample: &str) -> bool {
        !response_body_reads(sample).is_empty()
    }

    #[test]
    fn council_p1_method_chain_into_is_a_response_move() {
        let hits = [
            "response.clone().into()",
            "response.by_ref().try_into()",
            "response.clone().by_ref().into()",
            "(response.clone()).into()",
            "response.clone::<u8>().into()",
            "(response).into()",
            "let reply = response; reply.clone().into()",
        ];
        for sample in hits {
            assert!(
                reads(sample),
                "method chain must keep the response receiver: {sample}"
            );
        }
        let misses = [
            "status.clone().into()",
            "rows.by_ref().try_into()",
            "foo(response).into()",
        ];
        for sample in misses {
            assert!(
                !reads(sample),
                "unrelated chain is not a body read: {sample}"
            );
        }
    }
}

pub(super) fn trailing_ident(source: &str) -> Option<String> {
    let mut start = source.len();
    for (index, ch) in source.char_indices().rev() {
        if !is_ident_char(ch) {
            break;
        }
        start = index;
    }
    let name = &source[start..];
    (!name.is_empty()).then(|| name.to_string())
}
