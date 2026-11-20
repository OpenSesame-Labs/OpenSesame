//! `let` binding names for credentialed dispatch aliases.
//!
//! Named types may contain `::`. `let name::_` and a `_` binding are not aliases.

use super::sync_target_pact_norm::string_len;

/// `let name: Type = Path::send` when `=` is not the byte immediately before the path.
pub(crate) fn typed_let_name_before_path(source: &str, head: usize) -> Option<String> {
    let prefix = &source[..head];
    let eq = last_single_eq(prefix)?;
    let bind = prefix[..eq].trim_end();
    // Untyped `let name =` is handled only when `=` sits against the path.
    let name = let_binding_name(bind)?;
    ascription_colon(statement_tail(bind)).map(|_| name)
}

/// Name in `let [mut] name[: Type]`.
pub(crate) fn let_binding_name(lhs: &str) -> Option<String> {
    let tail = statement_tail(lhs);
    let name_region = if let Some(colon) = ascription_colon(tail) {
        let ty = tail[colon + 1..].trim_start();
        if ty.is_empty() || ty.starts_with(':') {
            return None;
        }
        tail[..colon].trim_end()
    } else {
        tail
    };
    let name = trailing_ident(name_region)?;
    if name == "_" {
        return None;
    }
    let mut before = name_region[..name_region.len() - name.len()].trim_end();
    if ends_with_kw(before, "mut") {
        before = before[..before.len() - 3].trim_end();
    }
    ends_with_kw(before, "let").then_some(name)
}

/// Text after the previous `;` or `{`, so an earlier `let` is not this binding.
fn statement_tail(lhs: &str) -> &str {
    let bytes = lhs.as_bytes();
    let mut depth = 0i32;
    let mut index = bytes.len();
    while index > 0 {
        index -= 1;
        match bytes[index] {
            b'>' if index > 0 && bytes[index - 1] == b'-' => {}
            b')' | b']' | b'>' => depth += 1,
            b'(' | b'[' | b'<' if depth > 0 => depth -= 1,
            b';' | b'{' if depth == 0 => return lhs[index + 1..].trim(),
            _ => {}
        }
    }
    lhs.trim()
}

/// Type-ascription colon on one `let` tail. `::` in a named type is not one.
fn ascription_colon(tail: &str) -> Option<usize> {
    let bytes = tail.as_bytes();
    let mut depth = 0i32;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'<' => depth += 1,
            b')' | b']' | b'>' if depth > 0 => depth -= 1,
            b':' if depth == 0 && bytes.get(index + 1) == Some(&b':') => index += 1,
            b':' if depth == 0 => return Some(index),
            _ => {}
        }
        index += 1;
    }
    None
}

fn ends_with_kw(source: &str, keyword: &str) -> bool {
    source
        .strip_suffix(keyword)
        .is_some_and(|rest| rest.chars().next_back().is_none_or(|ch| !is_ident_char(ch)))
}

fn last_single_eq(prefix: &str) -> Option<usize> {
    let bytes = prefix.as_bytes();
    let mut index = prefix.len();
    while index > 0 {
        index -= 1;
        if bytes[index] != b'=' {
            continue;
        }
        if bytes.get(index + 1) == Some(&b'=') {
            continue;
        }
        if matches!(
            bytes.get(index.wrapping_sub(1)),
            Some(b'!' | b'=' | b'<' | b'>')
        ) {
            continue;
        }
        return Some(index);
    }
    None
}

fn trailing_ident(source: &str) -> Option<String> {
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

fn is_ident_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}
