//! Call tails and statement boundaries for bind analysis.
use super::super::super::sync_target_pact_norm::string_len;
use super::super::{is_ident_char, strip_turbofish};

pub(in super::super) fn ident_prefix(expr: &str) -> &str {
    let end = expr
        .char_indices()
        .find(|(_, ch)| !is_ident_char(*ch))
        .map(|(index, _)| index)
        .unwrap_or(expr.len());
    &expr[..end]
}

pub(in super::super) fn strip_ref(arg: &str) -> &str {
    arg.strip_prefix("&mut ")
        .or_else(|| arg.strip_prefix('&'))
        .unwrap_or(arg)
}

pub(in super::super) fn is_single_eq(bytes: &[u8], index: usize) -> bool {
    bytes.get(index) == Some(&b'=')
        && !matches!(bytes.get(index + 1), Some(b'=' | b'>'))
        && !matches!(
            index.checked_sub(1).and_then(|prev| bytes.get(prev)),
            Some(b'=' | b'!' | b'<' | b'>')
        )
}

/// Argument list opener for `name(…)`, `name::<T>(…)`, and `(name)(…)` /
/// `(name)::<T>(…)` alias dispatches.
pub(in super::super) fn call_tail(source: &str, at: usize) -> Option<&str> {
    let rest = &source[at..];
    let name_len = leading_ident(rest).len();
    if name_len == 0 {
        return None;
    }
    let mut tail = rest[name_len..].trim_start();
    tail = strip_turbofish(tail).unwrap_or(tail).trim_start();
    if tail.starts_with('(') {
        return Some(tail);
    }
    loop {
        let Some(stripped) = tail.strip_prefix(')') else {
            break;
        };
        tail = strip_turbofish(stripped).unwrap_or(stripped).trim_start();
        if tail.starts_with('(') {
            return Some(tail);
        }
        if !tail.starts_with(')') {
            break;
        }
    }
    None
}

fn leading_ident(source: &str) -> &str {
    let end = source
        .char_indices()
        .find(|(_, ch)| !is_ident_char(*ch))
        .map(|(index, _)| index)
        .unwrap_or(source.len());
    &source[..end]
}

pub(in super::super) fn stmt_end(bytes: &[u8], start: usize) -> usize {
    let (mut depth, mut index) = (0i32, start);
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' if depth > 0 => depth -= 1,
            b';' if depth == 0 => return index,
            _ => {}
        }
        index += 1;
    }
    bytes.len()
}
