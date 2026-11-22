//! Argument and paren walks for response-chain roots.
//!
//! Block comments are not code. `/* ) */` and `/* , */` must not close a call
//! or split its first argument. Neither are `<…>` generic args: a comma
//! inside them belongs to the type, not the argument list.
use super::super::sync_target_pact_norm::non_code_len;
use super::is_ident_char;

/// First argument of the call opened at `open`. Commas inside `<…>` generic
/// args (`S::<A, B>::new(response)`) do not split it: the angle brackets
/// carry their own depth, so a UFCS root keeps its whole first argument.
pub(super) fn first_arg(source: &str, open: usize) -> Option<&str> {
    let bytes = source.as_bytes();
    let (mut depth, mut angles) = (0i32, 0i32);
    let start = open + 1;
    let mut index = start;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' if depth > 0 => depth -= 1,
            b'<' if bytes.get(index + 1) != Some(&b'=') => angles += 1,
            // `Fn() -> T`, `=>`, and `>=` are not generic closers; a `>`
            // with no open angle is a comparison and leaves the list alone.
            b'>' if angles > 0
                && !matches!(bytes.get(index - 1), Some(b'-' | b'='))
                && bytes.get(index + 1) != Some(&b'=') =>
            {
                angles -= 1;
            }
            b',' | b')' if depth == 0 && angles == 0 => {
                return Some(source[start..index].trim());
            }
            _ => {}
        }
        index += 1;
    }
    None
}

/// Receiver place: `response`, `&mut response`, `response.clone()`, `self.response`.
/// Leading comments (`/* , */ response`) are not part of the place.
pub(super) fn place_ident(expr: &str) -> Option<String> {
    let mut expr = trim_noise(expr);
    loop {
        if let Some(rest) = strip_ref_prefix(expr) {
            expr = trim_noise(rest);
            continue;
        }
        if let Some(inner) = outer_group(expr) {
            expr = trim_noise(inner);
            continue;
        }
        if let Some(recv) = method_receiver(expr) {
            expr = trim_noise(recv);
            continue;
        }
        break;
    }
    let name = trim_noise(expr.rsplit('.').next().unwrap_or(expr));
    plain_place(name).then(|| name.to_string())
}

/// Drop whitespace and comments at both ends. Code in the middle stays.
fn trim_noise(expr: &str) -> &str {
    let bytes = expr.as_bytes();
    let mut start = 0usize;
    loop {
        if let Some(len) = non_code_len(bytes, start) {
            start += len;
            continue;
        }
        if bytes.get(start).is_some_and(u8::is_ascii_whitespace) {
            start += 1;
            continue;
        }
        break;
    }
    let mut end = start;
    let mut cursor = start;
    while cursor < bytes.len() {
        if let Some(len) = non_code_len(bytes, cursor) {
            cursor += len;
            continue;
        }
        if !bytes[cursor].is_ascii_whitespace() {
            end = cursor + 1;
        }
        cursor += 1;
    }
    &expr[start..end]
}

fn strip_ref_prefix(expr: &str) -> Option<&str> {
    if let Some(rest) = expr.strip_prefix("&mut") {
        if rest.chars().next().is_none_or(|ch| !is_ident_char(ch)) {
            return Some(rest.trim_start());
        }
    }
    expr.starts_with(['&', '*']).then(|| expr[1..].trim_start())
}

fn outer_group(expr: &str) -> Option<&str> {
    if !expr.starts_with('(') {
        return None;
    }
    let close = paren_close(expr, 0)?;
    (close + 1 == expr.len()).then(|| expr[1..close].trim())
}

fn method_receiver(expr: &str) -> Option<&str> {
    let open = paren_open_at_end(expr)?;
    let before = expr[..open].trim_end();
    let dot = before.rfind('.')?;
    let method = before[dot + 1..].trim();
    plain_place(method).then(|| before[..dot].trim())
}

fn plain_place(name: &str) -> bool {
    !name.is_empty() && name.chars().all(is_ident_char)
}

fn paren_close(source: &str, open: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    if bytes.get(open) != Some(&b'(') {
        return None;
    }
    let mut depth = 0i32;
    let mut index = open;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn paren_open_at_end(source: &str) -> Option<usize> {
    let bytes = source.as_bytes();
    if bytes.last() != Some(&b')') {
        return None;
    }
    let mut stack = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' => stack.push(index),
            b')' => {
                let open = stack.pop()?;
                if index + 1 == bytes.len() {
                    return Some(open);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

pub(super) fn matching_open_paren(source: &str, close: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut stack = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
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
    use super::*;

    /// Commas inside `<…>` generic args do not truncate the first argument,
    /// including an `Fn() -> T` arrow inside the angle brackets.
    #[test]
    fn chunk01_generic_commas_do_not_split_the_first_arg() {
        let cases = [
            (
                "StreamExt::map(S::<A, B>::new(response), |b| b)",
                "S::<A, B>::new(response)",
            ),
            (
                "StreamExt::for_each(spawn::<Fn() -> T, U>(response), f)",
                "spawn::<Fn() -> T, U>(response)",
            ),
            (
                "futures::StreamExt::map(self.wrap::<A, B>(&response), f)",
                "self.wrap::<A, B>(&response)",
            ),
        ];
        for (source, expected) in cases {
            let open = source.find('(').expect("call open");
            assert_eq!(first_arg(source, open), Some(expected), "{source}");
        }
    }

    /// Comparison arrows are not generic brackets: the argument list still
    /// splits at its own commas and closes.
    #[test]
    fn chunk01_comparisons_keep_the_argument_split() {
        let cases = [
            (
                "StreamExt::map(response.clone(), |b| b)",
                "response.clone()",
            ),
            ("f(x > y, z)", "x > y"),
            ("f(g(x), |v| -> T { v })", "g(x)"),
            ("f(a <= b, c >= d)", "a <= b"),
        ];
        for (source, expected) in cases {
            let open = source.find('(').expect("call open");
            assert_eq!(first_arg(source, open), Some(expected), "{source}");
        }
    }
}
