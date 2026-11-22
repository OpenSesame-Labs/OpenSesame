//! `.execute` is a Reqwest send unless the receiver is a SQLx query.
//!
//! `let pool = request.build()?; query.execute(pool)` is HTTP. The names
//! `query` and `pool` do not make it a database call. `sqlx::query(...).execute`
//! and a binding of that expression do.

use super::super::sync_target_pact_norm::{is_keyword_at, string_len};
use super::{is_ident_byte, is_ident_char};

pub(super) fn receiver_is_sqlx(source: &str, execute_at: usize) -> bool {
    let recv = statement_receiver(source, execute_at);
    // The receiver itself must be the query at its head. A wrapper that
    // merely contains `sqlx::query` (`wrap(sqlx::query("s"))`) is an HTTP
    // chain, not a database call.
    if initializer_is_sqlx(recv) {
        return true;
    }
    let name = trailing_ident(recv);
    if !name.is_empty() {
        return binding_is_sqlx(&source[..execute_at], &name);
    }
    // `query.bind(1).execute(…)` chains end in `)`, so the trailing ident is
    // empty; the head binding is the query.
    let head = leading_ident(query_head(recv.trim()));
    !head.is_empty() && binding_is_sqlx(&source[..execute_at], &head)
}

/// The binding's value is a SQLx query. `wrap(sqlx::query(…))` only mentions
/// SQLx inside the wrapper, so the bound value is still an HTTP client.
fn initializer_is_sqlx(expr: &str) -> bool {
    sqlx_query_at(query_head(expr.trim()), 0)
}

fn sqlx_query_at(expr: &str, index: usize) -> bool {
    let bytes = expr.as_bytes();
    if index > 0 && is_ident_byte(bytes[index - 1]) {
        return false;
    }
    let Some(after) = expr[index..].strip_prefix("sqlx::") else {
        return false;
    };
    let name = if after.starts_with("query") {
        "query"
    } else if after.starts_with("Query") {
        "Query"
    } else {
        return false;
    };
    let end = index + "sqlx::".len() + name.len();
    bytes.get(end).is_none_or(|byte| !is_ident_byte(*byte))
}

fn binding_is_sqlx(prefix: &str, name: &str) -> bool {
    let mut current = name.to_string();
    for _ in 0..4 {
        let Some(rhs) = let_rhs(prefix, &current) else {
            return false;
        };
        if initializer_is_sqlx(rhs) {
            return true;
        }
        let Some(next) = sole_ident(rhs) else {
            return false;
        };
        if next == current {
            return false;
        }
        current = next.to_string();
    }
    false
}

/// The expression with leading `&` / `&mut` and grouping parens peeled, so
/// the head of the value is visible for the `sqlx::query` check.
fn query_head(mut expr: &str) -> &str {
    loop {
        expr = expr.trim_start();
        if let Some(rest) = strip_leading_ref(expr) {
            expr = rest;
            continue;
        }
        let Some(inner) = grouped_query(expr) else {
            return expr;
        };
        expr = inner;
    }
}

fn strip_leading_ref(expr: &str) -> Option<&str> {
    if let Some(rest) = expr.strip_prefix("&mut") {
        if rest.chars().next().is_none_or(|ch| !is_ident_char(ch)) {
            return Some(rest);
        }
    }
    expr.strip_prefix('&')
}

/// `(sqlx::query(…)).bind(…)` is still that query. A call that merely contains
/// one is not a group: its `(` is not peeled.
fn grouped_query(expr: &str) -> Option<&str> {
    let rest = expr.strip_prefix('(')?;
    let bytes = rest.as_bytes();
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
                    let tail = rest[index + 1..].trim_start();
                    if tail.is_empty() || tail.starts_with(['.', '?']) {
                        return Some(rest[..index].trim());
                    }
                    return None;
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

/// Visible `let name` at the end of `prefix`. A binding inside a finished
/// block or function does not count.
fn let_rhs<'a>(prefix: &'a str, name: &str) -> Option<&'a str> {
    let bytes = prefix.as_bytes();
    let mut index = 0usize;
    let mut depth = 0i32;
    let mut stack: Vec<(i32, usize, usize)> = Vec::new();
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' => {
                depth += 1;
                index += 1;
                continue;
            }
            b'}' => {
                if depth > 0 {
                    depth -= 1;
                }
                while stack.last().is_some_and(|(live, _, _)| *live > depth) {
                    stack.pop();
                }
                index += 1;
                continue;
            }
            _ => {}
        }
        if is_keyword_at(bytes, index, b"let") {
            push_named_let(&mut stack, prefix, index, name, depth);
        }
        index += 1;
    }
    stack
        .last()
        .map(|&(_, start, end)| prefix[start..end].trim())
}

fn push_named_let(
    stack: &mut Vec<(i32, usize, usize)>,
    prefix: &str,
    index: usize,
    name: &str,
    depth: i32,
) {
    let Some(span) = named_rhs_span(prefix, index, name) else {
        return;
    };
    if stack.last().is_some_and(|(live, _, _)| *live == depth) {
        stack.pop();
    }
    stack.push((depth, span.0, span.1));
}

fn named_rhs_span(prefix: &str, let_at: usize, name: &str) -> Option<(usize, usize)> {
    let (start, end) = named_rhs_bounds(prefix, let_at, name)?;
    let raw = &prefix[start..end];
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lead = raw.len() - raw.trim_start().len();
    let at = start + lead;
    Some((at, at + trimmed.len()))
}

fn named_rhs_bounds(prefix: &str, let_at: usize, name: &str) -> Option<(usize, usize)> {
    let bytes = prefix.as_bytes();
    let mut at = skip_ws(bytes, let_at + 3);
    if is_keyword_at(bytes, at, b"mut") {
        at = skip_ws(bytes, at + 3);
    }
    let start = at;
    while at < bytes.len() && is_ident_byte(bytes[at]) {
        at += 1;
    }
    if &prefix[start..at] != name {
        return None;
    }
    at = skip_ws(bytes, at);
    if bytes.get(at) == Some(&b':') && bytes.get(at + 1) != Some(&b':') {
        at = skip_ws(bytes, skip_type(bytes, at + 1));
    }
    if !is_single_eq(bytes, at) {
        return None;
    }
    let rhs_at = skip_ws(bytes, at + 1);
    Some((rhs_at, stmt_end(bytes, rhs_at)))
}

fn statement_receiver(source: &str, end: usize) -> &str {
    let bytes = source.as_bytes();
    let mut depth = 0i32;
    let mut index = end;
    let mut start = 0usize;
    while index > 0 {
        index -= 1;
        match bytes[index] {
            b')' | b']' => depth += 1,
            // A finished block is the previous statement, not this receiver.
            b'}' if depth == 0 => {
                start = index + 1;
                break;
            }
            b'}' => depth += 1,
            b'(' | b'[' | b'{' if depth == 0 => {
                start = index + 1;
                break;
            }
            b'(' | b'[' | b'{' => depth -= 1,
            b';' if depth == 0 => {
                start = index + 1;
                break;
            }
            _ => {}
        }
    }
    source[start..end].trim()
}

fn sole_ident(expr: &str) -> Option<&str> {
    let expr = expr.trim().trim_start_matches(['&', '*']).trim_start();
    let mut end = 0usize;
    for ch in expr.chars() {
        if !is_ident_char(ch) {
            break;
        }
        end += ch.len_utf8();
    }
    let name = &expr[..end];
    (!name.is_empty() && expr[end..].trim().is_empty()).then_some(name)
}

fn leading_ident(expr: &str) -> String {
    expr.trim_start()
        .chars()
        .take_while(|ch| is_ident_char(*ch))
        .collect()
}

fn trailing_ident(expr: &str) -> String {
    expr.trim_end()
        .chars()
        .rev()
        .take_while(|ch| is_ident_char(*ch))
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn stmt_end(bytes: &[u8], start: usize) -> usize {
    let mut depth = 0i32;
    let mut index = start;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            // `<` in `port < 443` is a comparison. Counting it as a generic
            // skips the statement semicolon and can swallow a later `sqlx::query`.
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' if depth > 0 => depth -= 1,
            b';' if depth == 0 => return index,
            _ => {}
        }
        index += 1;
    }
    bytes.len()
}

fn skip_type(bytes: &[u8], mut at: usize) -> usize {
    let mut depth = 0i32;
    while at < bytes.len() {
        if let Some(len) = string_len(bytes, at) {
            at += len;
            continue;
        }
        match bytes[at] {
            b'<' | b'(' | b'[' => depth += 1,
            b'>' | b')' | b']' if depth > 0 => depth -= 1,
            b'=' if depth == 0 => return at,
            _ => {}
        }
        at += 1;
    }
    at
}

fn skip_ws(bytes: &[u8], mut at: usize) -> usize {
    while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
        at += 1;
    }
    at
}

fn is_single_eq(bytes: &[u8], at: usize) -> bool {
    bytes.get(at) == Some(&b'=') && !matches!(bytes.get(at + 1), Some(b'=' | b'>'))
}

#[path = "sqlx_probes.rs"]
#[cfg(test)]
mod probes;
