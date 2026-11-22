//! URL-parse provenance: which URL a `Url::parse` on the guard subject read.
//!
//! The value comes from the outer `Url::parse`. A parse nested in `unwrap_or`
//! / `unwrap_or_else` is only the fallback argument, so
//! `Url::parse(evil).unwrap_or(Url::parse(url).unwrap())` can still be `evil`,
//! and a parse that `.map(…)` / `.and_then(…)` replaces is not the parse at
//! all: `Url::parse(&url).map(|_| decoy)` checks `decoy`, not `url`.
use super::super::super::sync_target_pact_norm::{is_keyword_at, non_code_len, string_len};
use super::super::{after_paren, is_ident_byte};
use super::{args_of, first_arg, plain_ident, strip_ref};

pub(super) fn last_rhs<'a>(source: &'a str, name: &str) -> Option<(&'a str, usize)> {
    let bytes = source.as_bytes();
    // The guard reads the binding visible at its own depth. A binding made
    // deeper than that sits in a block which has already closed, so it is
    // scoped away: the textual-last `let parsed = Url::parse(&url)` inside a
    // finished `if` block must not lend `url` provenance to the outer
    // `parsed` (Kimi council chunk03 P1).
    let mut visible = 0i32;
    let mut scan = 0usize;
    while scan < bytes.len() {
        if let Some(len) = non_code_len(bytes, scan) {
            scan += len;
            continue;
        }
        match bytes[scan] {
            b'{' => visible += 1,
            b'}' => visible -= 1,
            _ => {}
        }
        scan += 1;
    }
    let mut index = 0usize;
    let mut depth = 0i32;
    let mut found = None;
    while index < bytes.len() {
        // Comments are not code: a commented-out rebinding is not the "last"
        // RHS, so it cannot lend its provenance to the guard subject.
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            _ => {}
        }
        if depth <= visible && is_keyword_at(bytes, index, name.as_bytes()) {
            // `let parsed: Url = Url::parse(&url)` — `=` is not the next byte.
            if let Some(eq) = super::super::bind::eq_after_name(bytes, index + name.len()) {
                let end = super::super::bind::stmt_end(bytes, eq + 1);
                found = Some((&source[eq + 1..end], end));
                index = end;
                continue;
            }
        }
        index += 1;
    }
    found
}

pub(super) fn url_parse_arg(rhs: &str) -> Option<&str> {
    let mut expr = rhs.trim();
    while let Some(inner) = grouped_value(expr) {
        // The group keeps its tail: `(parse).map(…)` transforms the value the
        // same way a direct `.map(…)` does.
        if transforms_value(group_tail(expr)) {
            return None;
        }
        expr = inner.trim();
    }
    let at = supplying_parse(expr)?;
    if transforms_value(parse_tail(&expr[at..])) {
        return None;
    }
    plain_parse_arg(&expr[at..])
}

/// `Url::parse` at the head of the value. Stops before call arguments, so a
/// nested parse cannot replace the outer argument.
fn supplying_parse(expr: &str) -> Option<usize> {
    let bytes = expr.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if url_parse_at(expr, index) {
            return path_prefix(expr[..index].trim()).then_some(index);
        }
        match bytes[index] {
            b'(' | b'{' | b'[' | b';' | b',' | b'=' => return None,
            _ => index += 1,
        }
    }
    None
}

/// `(expr).method()` groups `expr`. The parentheses are not a wrapper call.
fn grouped_value(expr: &str) -> Option<&str> {
    let rest = expr.trim().strip_prefix('(')?;
    let after = after_paren(rest)?;
    let tail = after.trim_start();
    if !(tail.is_empty() || tail.starts_with(['.', '?'])) {
        return None;
    }
    Some(rest[..rest.len() - after.len() - 1].trim())
}

/// Bytes after the `)` that closes a leading group.
fn group_tail(grouped: &str) -> &str {
    grouped
        .strip_prefix('(')
        .and_then(after_paren)
        .unwrap_or("")
}

/// Bytes after the `)` of the head `Url::parse(…)`.
fn parse_tail(at_parse: &str) -> &str {
    at_parse["Url::parse".len()..]
        .strip_prefix('(')
        .and_then(after_paren)
        .unwrap_or("")
}

/// `.map(…)` / `.and_then(…)` replaces the parsed value with the closure's
/// result, so the guard subject no longer proves the destination's scheme.
fn transforms_value(tail: &str) -> bool {
    const CHANGERS: &[&str] = &["map", "and_then"];
    let bytes = tail.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes[index] == b'.'
            && CHANGERS
                .iter()
                .any(|name| method_opens(&tail[index + 1..], name))
        {
            return true;
        }
        index += 1;
    }
    false
}

/// `name(` / `name::<…>(` at the head: `.map(`, `.map::<T>(`, not
/// `.map_err(` or `.map_or(` (Kimi council chunk03 P2: a turbofish'd
/// value-replacing adapter still replaces the parsed value).
fn method_opens(at: &str, name: &str) -> bool {
    let Some(rest) = at.strip_prefix(name) else {
        return false;
    };
    super::super::strip_turbofish(rest)
        .unwrap_or(rest)
        .starts_with('(')
}

/// Empty, or a path ending in `::` (`url::`, `foo::bar::`).
fn path_prefix(prefix: &str) -> bool {
    if prefix.is_empty() {
        return true;
    }
    let bytes = prefix.as_bytes();
    let mut index = 0usize;
    loop {
        if index >= bytes.len() || !is_ident_byte(bytes[index]) {
            return false;
        }
        while index < bytes.len() && is_ident_byte(bytes[index]) {
            index += 1;
        }
        if index == bytes.len() || !prefix[index..].starts_with("::") {
            return false;
        }
        index += 2;
        if index == bytes.len() {
            return true;
        }
    }
}

fn url_parse_at(rhs: &str, index: usize) -> bool {
    let bytes = rhs.as_bytes();
    rhs[index..].starts_with("Url::parse(") && (index == 0 || !is_ident_byte(bytes[index - 1]))
}

fn plain_parse_arg(at_parse: &str) -> Option<&str> {
    let inner = args_of(&at_parse["Url::parse".len()..])?;
    let arg = strip_ref(first_arg(inner));
    plain_ident(arg).is_some().then_some(arg)
}
