//! Builder URLs and call-argument splits for credentialed dispatch.
use super::super::super::sync_target_pact_norm::{non_code_len, string_len};
use super::super::strip_turbofish;
use super::{ident_prefix, is_single_eq, strip_ref};

/// `=` after `name`, skipping a type ascription (`let request: T =`).
pub(crate) fn eq_after_name(bytes: &[u8], mut at: usize) -> Option<usize> {
    if bytes.get(at) == Some(&b':') && bytes.get(at + 1) != Some(&b':') {
        at = skip_ascription(bytes, at + 1);
    }
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    is_single_eq(bytes, at).then_some(at)
}

pub(crate) fn builder_url(expr: &str) -> Option<&str> {
    marked_url(expr).or_else(|| call_arg_url(expr))
}

/// Whether `expr` contains a request-builder method call (`.get(`, `.post(`,
/// `.request(`, …). Used as ownership-escape evidence: a binding whose value
/// constructs a request passes the builder on to a wrapper that receives it.
pub(super) fn has_builder_call(expr: &str) -> bool {
    let bytes = expr.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if builder_paren(expr, index).is_some() {
            return true;
        }
        index += 1;
    }
    false
}

fn marked_url(expr: &str) -> Option<&str> {
    let bytes = expr.as_bytes();
    let mut index = 0usize;
    // Disagreeing branch URLs and unproven marks (`url.clone()`, `url,`) fail closed.
    let mut found: Option<&str> = None;
    let mut bad = false;
    while index < bytes.len() {
        // Comments are not code: a commented-out `.get(evil)` must not mark
        // a URL or count as builder evidence (`call_arg_url` already walks
        // with `non_code_len`; Kimi council chunk03 P2).
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if let Some(at_paren) = builder_paren(expr, index) {
            let url = call_inside(&expr[at_paren..])
                .and_then(|inner| plain_ident(strip_ref(split_arg(inner, false))));
            bad |= !note_mark(&mut found, url);
        }
        index += 1;
    }
    if bad {
        Some("")
    } else {
        found
    }
}

/// `.get::<T>(` / `::request::<T>(`. A longer ident (`.get_mut`) is not a
/// builder, and neither is UFCS on a type name (`Cache::get(key)`): the
/// uppercase-type-segment exclusion `is_free_call` / `escape.rs` apply, or
/// the associated function fabricates builder-URL evidence (Kimi council
/// chunk03 P2).
fn builder_paren(expr: &str, index: usize) -> Option<usize> {
    const METHODS: &[&str] = &["request", "get", "post", "put", "patch", "delete", "head"];
    let rest = &expr[index..];
    let sep = if rest.starts_with('.') {
        1
    } else if rest.starts_with("::") {
        if type_segment_before(expr.as_bytes(), index) {
            return None;
        }
        2
    } else {
        return None;
    };
    let after_sep = &rest[sep..];
    let method = METHODS
        .iter()
        .copied()
        .find(|method| after_sep.starts_with(method))?;
    let method_end = index + sep + method.len();
    if expr
        .as_bytes()
        .get(method_end)
        .is_some_and(|byte| super::super::is_ident_byte(*byte))
    {
        return None;
    }
    let tail = &expr[method_end..];
    let after = strip_turbofish(tail).unwrap_or(tail);
    if !after.starts_with('(') {
        return None;
    }
    Some(method_end + (tail.len() - after.len()))
}

/// The identifier segment before `at` starts uppercase: a type name
/// (`Cache::get`) rather than a module path (`reqwest::get`). Same check as
/// `escape.rs`.
fn type_segment_before(bytes: &[u8], at: usize) -> bool {
    let mut start = at;
    while start > 0 && super::super::is_ident_byte(bytes[start - 1]) {
        start -= 1;
    }
    matches!(bytes.get(start), Some(b'A'..=b'Z'))
}

/// `false` when this mark disagrees with a URL already seen, or is unproven.
fn note_mark<'a>(found: &mut Option<&'a str>, url: Option<&'a str>) -> bool {
    match (*found, url) {
        (_, None) => false,
        (None, Some(url)) => {
            *found = Some(url);
            true
        }
        (Some(prev), Some(url)) => prev == url,
    }
}

/// Last plain-ident argument of a free function call (`build_request(other)`).
/// Method calls (`.json(&body)`) do not choose the URL.
fn call_arg_url(expr: &str) -> Option<&str> {
    let bytes = expr.as_bytes();
    let mut index = 0usize;
    let mut found = None;
    let mut disagreed = false;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if let Some(url) = free_call_url(expr, index) {
            // `build(evil)` and `build(url)` are not one URL. Same rule as `.get`.
            if !note_mark(&mut found, Some(url)) {
                disagreed = true;
            }
        }
        index += 1;
    }
    if disagreed {
        Some("")
    } else {
        found
    }
}

fn free_call_url(expr: &str, index: usize) -> Option<&str> {
    if expr.as_bytes().get(index) != Some(&b'(') || !is_free_call(expr, index) {
        return None;
    }
    let inner = call_inside(&expr[index..])?;
    if call_arg_count(inner) != 1 {
        return None;
    }
    plain_ident(strip_ref(split_arg(inner, false)))
}

fn call_arg_count(args: &str) -> usize {
    let bytes = args.as_bytes();
    let (mut depth, mut index, mut start, mut count) = (0i32, 0usize, 0usize, 1usize);
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' if depth > 0 => depth -= 1,
            b',' if depth == 0 => {
                if !args[start..index].trim().is_empty() {
                    count += 1;
                }
                start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    if args[start..].trim().is_empty() && count > 1 {
        count -= 1;
    }
    count
}

fn is_free_call(expr: &str, paren: usize) -> bool {
    let bytes = expr.as_bytes();
    if paren == 0 {
        return false;
    }
    // UFCS (`Type::from(row)`) is a method shape, not a free call, and a
    // parenthesized keyword (`if (url)`) is a condition, not a callee; either
    // would let a coincidental scheme guard cover an unrelated send (Kimi
    // council chunk03 P2). `build_request::<T>(url)` is still a free call:
    // the byte before `(` may be the turbofish closer, like `builder_paren`.
    let Some((start, name_end)) = callee_span(bytes, paren) else {
        return false;
    };
    let prev = start.checked_sub(1).and_then(|at| bytes.get(at));
    if prev.is_some_and(|byte| matches!(byte, b'.' | b':')) {
        return false;
    }
    !matches!(
        &expr[start..name_end],
        "if" | "while" | "match" | "for" | "loop" | "return" | "break" | "continue"
    )
}

/// Callee name span before `paren`: `name` or `name::<…>`. A `>` inside a
/// const-generic block (`{1 > 0}`) is a comparison, like the forward
/// `strip_turbofish`.
fn callee_span(bytes: &[u8], paren: usize) -> Option<(usize, usize)> {
    if super::super::is_ident_byte(bytes[paren - 1]) {
        let mut start = paren;
        while start > 0 && super::super::is_ident_byte(bytes[start - 1]) {
            start -= 1;
        }
        return Some((start, paren));
    }
    if bytes[paren - 1] != b'>' {
        return None;
    }
    let (mut depth, mut brace, mut index) = (0i32, 0i32, paren);
    while index > 0 {
        index -= 1;
        match bytes[index] {
            b'>' if brace == 0 => depth += 1,
            b'<' if brace == 0 && depth == 1 => return turbofish_name(bytes, index),
            b'<' if brace == 0 => depth -= 1,
            b'}' => brace += 1,
            b'{' => brace = brace.saturating_sub(1),
            _ => {}
        }
    }
    None
}

/// The path segment named by `name::<`, given the index of its `<`.
fn turbofish_name(bytes: &[u8], open: usize) -> Option<(usize, usize)> {
    if open < 2 || bytes[open - 1] != b':' || bytes[open - 2] != b':' {
        return None;
    }
    let name_end = open - 2;
    let mut start = name_end;
    while start > 0 && super::super::is_ident_byte(bytes[start - 1]) {
        start -= 1;
    }
    (start < name_end).then_some((start, name_end))
}

pub(crate) fn skip_ascription(bytes: &[u8], start: usize) -> usize {
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
            b'=' | b',' | b';' if depth == 0 => return index,
            _ => {}
        }
        index += 1;
    }
    index
}

pub(super) fn head_args(rest: &str) -> Option<&str> {
    const HEADS: &[&str] = &["::execute", "::send", ".execute", ".send"];
    let head = HEADS.iter().copied().find(|head| rest.starts_with(head))?;
    let after = strip_turbofish(&rest[head.len()..]).unwrap_or(&rest[head.len()..]);
    call_inside(after)
}

pub(crate) fn call_inside(at_paren: &str) -> Option<&str> {
    let bytes = at_paren.strip_prefix('(')?.as_bytes();
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
                    return Some(&at_paren[1..index + 1]);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

pub(crate) fn split_arg(args: &str, first: bool) -> &str {
    let bytes = args.as_bytes();
    let (mut depth, mut index, mut start) = (0i32, 0usize, 0usize);
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' if depth > 0 => depth -= 1,
            b',' if depth == 0 => {
                if first {
                    return args[..index].trim();
                }
                start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    args[start..].trim()
}

pub(crate) fn plain_ident(expr: &str) -> Option<&str> {
    let name = ident_prefix(expr);
    (name.len() == expr.len() && !name.is_empty()).then_some(name)
}

pub(super) fn plain_receiver(expr: &str) -> Option<&str> {
    let mut expr = expr.trim();
    while let Some(inner) = expr
        .strip_prefix('(')
        .and_then(|rest| rest.strip_suffix(')'))
    {
        expr = inner.trim();
    }
    let expr = expr.strip_prefix("&mut ").unwrap_or(expr);
    plain_ident(expr.strip_prefix('&').unwrap_or(expr).trim())
}

#[path = "bind_url_probes.rs"]
#[cfg(test)]
mod probes;
