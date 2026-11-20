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

fn marked_url(expr: &str) -> Option<&str> {
    let bytes = expr.as_bytes();
    let mut index = 0usize;
    // Disagreeing branch URLs and unproven marks (`url.clone()`, `url,`) fail closed.
    let mut found: Option<&str> = None;
    let mut bad = false;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
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

/// `.get::<T>(` / `::request::<T>(`. A longer ident (`.get_mut`) is not a builder.
fn builder_paren(expr: &str, index: usize) -> Option<usize> {
    const METHODS: &[&str] = &["request", "get", "post", "put", "patch", "delete", "head"];
    let rest = &expr[index..];
    let sep = if rest.starts_with('.') {
        1
    } else if rest.starts_with("::") {
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
    if paren == 0 || !super::super::is_ident_byte(bytes[paren - 1]) {
        return false;
    }
    let mut start = paren;
    while start > 0 && super::super::is_ident_byte(bytes[start - 1]) {
        start -= 1;
    }
    start == 0 || bytes[start - 1] != b'.'
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
