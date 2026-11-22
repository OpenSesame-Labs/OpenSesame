//! `.execute` is a Reqwest send unless the receiver is a SQLx query.
//!
//! `let pool = request.build()?; query.execute(pool)` is HTTP. The names
//! `query` and `pool` do not make it a database call. `sqlx::query(...).execute`
//! and a binding of that expression do.

use super::super::sync_target_pact_norm::{is_keyword_at, string_len};
use super::{is_ident_byte, is_ident_char};

pub(super) fn receiver_is_sqlx(source: &str, execute_at: usize) -> bool {
    let recv = statement_receiver(source, execute_at);
    if has_sqlx_query(recv) {
        return true;
    }
    let name = trailing_ident(recv);
    !name.is_empty() && binding_is_sqlx(&source[..execute_at], &name)
}

fn has_sqlx_query(expr: &str) -> bool {
    expr.contains("sqlx::query") || expr.contains("sqlx::Query")
}

fn binding_is_sqlx(prefix: &str, name: &str) -> bool {
    let mut current = name.to_string();
    for _ in 0..4 {
        let Some(rhs) = let_rhs(prefix, &current) else {
            return false;
        };
        if has_sqlx_query(rhs) {
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

fn let_rhs<'a>(prefix: &'a str, name: &str) -> Option<&'a str> {
    let bytes = prefix.as_bytes();
    let mut index = 0usize;
    let mut found = None;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if is_keyword_at(bytes, index, b"let") {
            if let Some(rhs) = named_rhs(prefix, index, name) {
                found = Some(rhs);
            }
        }
        index += 1;
    }
    found
}

fn named_rhs<'a>(prefix: &'a str, let_at: usize, name: &str) -> Option<&'a str> {
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
    let end = stmt_end(bytes, rhs_at);
    Some(prefix[rhs_at..end].trim())
}

fn statement_receiver(source: &str, end: usize) -> &str {
    let bytes = source.as_bytes();
    let mut depth = 0i32;
    let mut index = end;
    let mut start = 0usize;
    while index > 0 {
        index -= 1;
        match bytes[index] {
            b')' | b']' | b'}' => depth += 1,
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
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' if depth > 0 => depth -= 1,
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
