//! Expression peeling and receiver names.
use super::super::sync_target_pact_norm::string_len;
use super::bind::{plain_name, read_ident_at};
use super::marker::is_ident_char;

pub(super) fn receiver_before(source: &str, dot: usize) -> String {
    let prefix = source[..dot].trim_end();
    if prefix.ends_with(')') {
        if let Some(name) = paren_group_ident(prefix) {
            return name;
        }
    }
    trailing_ident(prefix).unwrap_or_default()
}

fn paren_group_ident(prefix: &str) -> Option<String> {
    let open = matching_open(prefix, prefix.len() - 1)?;
    if open > 0 {
        let prev = prefix[..open].trim_end();
        if prev.ends_with(|ch: char| is_ident_char(ch) || ch == '.') {
            return None;
        }
    }
    plain_name(&prefix[open + 1..prefix.len() - 1])
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
