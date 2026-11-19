//! String, comment, and brace scanning for the pact source lexer.
//!
//! Character literals (`'"'`, `b'"'`, `'\n'`) are consumed before `"` opens a
//! cooked string, so a quote cannot hide `request.send()`.

pub(crate) fn string_len(bytes: &[u8], start: usize) -> Option<usize> {
    if start >= bytes.len() {
        return None;
    }
    if let Some(len) = char_lit_len(bytes, start) {
        return Some(len);
    }
    if let Some(len) = raw_string_len(&bytes[start..]) {
        return Some(len);
    }
    let mut index = start;
    if matches!(bytes.get(index), Some(b'b' | b'c')) && bytes.get(index + 1) == Some(&b'"') {
        index += 1;
    }
    if bytes.get(index) == Some(&b'"') {
        return Some(index - start + cooked_string_len(&bytes[index..]));
    }
    None
}

pub(crate) fn non_code_len(bytes: &[u8], index: usize) -> Option<usize> {
    if let Some(len) = char_lit_len(bytes, index).or_else(|| string_len(bytes, index)) {
        return Some(len);
    }
    if index + 1 < bytes.len() && bytes[index] == b'/' && matches!(bytes[index + 1], b'/' | b'*') {
        return Some(skip_comment(bytes, index) - index);
    }
    None
}

pub(super) fn skip_comment(bytes: &[u8], start: usize) -> usize {
    if bytes.get(start + 1) == Some(&b'/') {
        return skip_line_comment(bytes, start);
    }
    skip_block_comment_nested(bytes, start)
}

fn skip_line_comment(bytes: &[u8], start: usize) -> usize {
    let mut index = start + 2;
    while index < bytes.len() && bytes[index] != b'\n' {
        index += 1;
    }
    index
}

/// Rust block comments do not nest; the first `*/` ends the comment.
pub(crate) fn skip_block_comment_flat(bytes: &[u8], start: usize) -> usize {
    let mut index = start + 2;
    while index + 1 < bytes.len() {
        if bytes[index] == b'*' && bytes[index + 1] == b'/' {
            return index + 2;
        }
        index += 1;
    }
    bytes.len()
}

/// Noise stripping treats fake `/* /* */ tail */` as one comment so hidden
/// `.text()` cannot slip through after a spurious `*/`.
pub(crate) fn skip_block_comment_nested(bytes: &[u8], start: usize) -> usize {
    let mut index = start + 2;
    let mut depth = 1i32;
    while index + 1 < bytes.len() {
        if bytes[index] == b'/' && bytes[index + 1] == b'*' {
            depth += 1;
            index += 2;
            continue;
        }
        if bytes[index] == b'*' && bytes[index + 1] == b'/' {
            depth -= 1;
            index += 2;
            if depth == 0 {
                return index;
            }
            continue;
        }
        index += 1;
    }
    bytes.len()
}

pub(crate) fn match_brace(bytes: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut index = open;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' => depth += 1,
            b'}' => {
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

pub(crate) fn find_code_byte(bytes: &[u8], from: usize, target: u8) -> Option<usize> {
    let mut index = from;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes[index] == target {
            return Some(index);
        }
        index += 1;
    }
    None
}

pub(crate) fn function_spans(bytes: &[u8]) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if is_keyword_at(bytes, index, b"fn") {
            if let Some(open) = find_code_byte(bytes, index, b'{') {
                if let Some(close) = match_brace(bytes, open) {
                    spans.push((open, close));
                    index = open + 1;
                    continue;
                }
            }
        }
        index += 1;
    }
    spans
}

fn raw_string_len(bytes: &[u8]) -> Option<usize> {
    let mut index = 0usize;
    if matches!(bytes.first(), Some(b'b' | b'c')) {
        index = 1;
    }
    if bytes.get(index) != Some(&b'r') {
        return None;
    }
    index += 1;
    let hash_at = index;
    while bytes.get(index) == Some(&b'#') {
        index += 1;
    }
    if bytes.get(index) != Some(&b'"') {
        return None;
    }
    let hashes = index - hash_at;
    index += 1;
    while index < bytes.len() {
        if bytes[index] == b'"'
            && bytes[index + 1..].len() >= hashes
            && bytes[index + 1..index + 1 + hashes]
                .iter()
                .all(|byte| *byte == b'#')
        {
            return Some(index + 1 + hashes);
        }
        index += 1;
    }
    Some(bytes.len())
}

fn cooked_string_len(bytes: &[u8]) -> usize {
    let mut index = 1usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index = (index + 2).min(bytes.len()),
            b'"' => return index + 1,
            _ => index += 1,
        }
    }
    bytes.len()
}

fn char_lit_len(bytes: &[u8], start: usize) -> Option<usize> {
    let quote_at = if bytes.get(start) == Some(&b'\'') {
        start
    } else if bytes.get(start) == Some(&b'b') && bytes.get(start + 1) == Some(&b'\'') {
        start + 1
    } else {
        return None;
    };
    let end = char_body_end(bytes, quote_at + 1)?;
    (bytes.get(end) == Some(&b'\'')).then_some(end + 1 - start)
}

fn char_body_end(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start) == Some(&b'\\') {
        return escape_end(bytes, start);
    }
    let width = match bytes.get(start).copied()? {
        0..=127 => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        _ => return None,
    };
    (start + width <= bytes.len()).then_some(start + width)
}

fn escape_end(bytes: &[u8], slash: usize) -> Option<usize> {
    if bytes.get(slash + 1) == Some(&b'x')
        && bytes.get(slash + 2).is_some_and(u8::is_ascii_hexdigit)
        && bytes.get(slash + 3).is_some_and(u8::is_ascii_hexdigit)
    {
        return Some(slash + 4);
    }
    bytes.get(slash + 1).map(|_| slash + 2)
}

pub(crate) fn is_keyword_at(bytes: &[u8], index: usize, keyword: &[u8]) -> bool {
    let end = index + keyword.len();
    end <= bytes.len()
        && &bytes[index..end] == keyword
        && (index == 0 || !is_ident_byte(bytes[index - 1]))
        && (end == bytes.len() || !is_ident_byte(bytes[end]))
}

fn is_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

pub(super) fn is_ident_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

#[cfg(test)]
mod probes {
    use super::{skip_block_comment_flat, skip_block_comment_nested};
    use crate::tests::sync_target_pact_let::typed_let_name_before_path;

    #[test]
    fn p5_block_comment_noise_uses_nested_skip() {
        let bytes = br#"/* outer /* inner */ still */.text()"#;
        let flat = skip_block_comment_flat(bytes, 0);
        assert_eq!(&bytes[flat..], b" still */.text()");
        let nested = skip_block_comment_nested(bytes, 0);
        assert_eq!(&bytes[nested..], b".text()");
        let noise = super::skip_comment(bytes, 0);
        assert_eq!(noise, nested, "non_code_len must hide nested comment tails");
    }

    #[test]
    fn p5_block_comment_string_literal_is_not_code() {
        let bytes = br#"/* " */ response.text().await"#;
        let end = skip_block_comment_flat(bytes, 0);
        assert_eq!(&bytes[end..], br#" response.text().await"#);
    }

    #[test]
    fn p5_compound_assign_not_let_binding_eq() {
        assert!(
            crate::tests::sync_target_pact_let::binding_name_before("url += evil").is_none(),
            "`+=` must not parse as a `let name =` binding"
        );
    }
}
