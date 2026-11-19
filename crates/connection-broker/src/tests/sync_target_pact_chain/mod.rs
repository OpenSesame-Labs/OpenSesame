//! Response-receiver stream chains for the credentialed sync pact.
//!
//! `response.map(...).collect()` and `(&mut response).count()` consume the
//! body even though the terminator's immediate receiver is not `response`.

use super::sync_target_pact_norm::string_len;

/// `.collect(`, `.count(`, `.any(`, and the other stream terminators, including
/// adapter chains, when the chain root is a credentialed response receiver.
pub(crate) fn response_chain_consumer(scanned: &str) -> bool {
    const METHODS: &[&str] = &[
        "collect",
        "count",
        "last",
        "any",
        "find",
        "partition",
        "concat",
    ];
    METHODS
        .iter()
        .any(|method| chain_method_on_response(scanned, method))
}

fn chain_method_on_response(scanned: &str, method: &str) -> bool {
    for suffix in ["(", "::"] {
        let marker = format!(".{method}{suffix}");
        let mut offset = 0usize;
        while let Some(rel) = scanned[offset..].find(&marker) {
            let index = offset + rel;
            if chain_root_is_response(scanned, index) {
                return true;
            }
            offset = index + marker.len();
        }
    }
    false
}

fn chain_root_is_response(source: &str, dot: usize) -> bool {
    root_ident(source, dot).is_some_and(|name| {
        super::sync_target_pact_rename::tracks_response_receiver(source, dot, name)
    })
}

fn root_ident(source: &str, mut end: usize) -> Option<String> {
    loop {
        if end == 0 {
            return None;
        }
        let bytes = source.as_bytes();
        if bytes[end - 1] != b')' {
            let name = trailing_ident(&source[..end]);
            return (!name.is_empty()).then_some(name);
        }
        let open = matching_open_paren(source, end - 1)?;
        let name_end = skip_turbofish_before(source, open);
        if name_end > 0 && is_ident_byte(bytes[name_end - 1]) {
            let name_start = ident_start(source, name_end);
            if name_start > 0 && bytes[name_start - 1] == b'.' {
                end = name_start - 1;
                continue;
            }
            return None;
        }
        let inner = &source[open + 1..end - 1];
        if let Some(dot) = last_toplevel_dot(inner) {
            return root_ident(source, open + 1 + dot);
        }
        let name = trailing_ident(inner);
        return (!name.is_empty()).then_some(name);
    }
}

fn matching_open_paren(source: &str, close: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut stack = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
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

fn skip_turbofish_before(source: &str, open_paren: usize) -> usize {
    turbofish_start(source.as_bytes(), open_paren).unwrap_or(open_paren)
}

fn turbofish_start(bytes: &[u8], open_paren: usize) -> Option<usize> {
    if open_paren == 0 || bytes[open_paren - 1] != b'>' {
        return None;
    }
    let mut depth = 0i32;
    let mut index = open_paren - 1;
    loop {
        match bytes[index] {
            b'>' => depth += 1,
            b'<' => {
                depth -= 1;
                if depth == 0 {
                    return colons_before(bytes, index);
                }
            }
            _ => {}
        }
        if index == 0 {
            return None;
        }
        index -= 1;
    }
}

fn colons_before(bytes: &[u8], lt: usize) -> Option<usize> {
    (lt >= 2 && bytes[lt - 1] == b':' && bytes[lt - 2] == b':').then_some(lt - 2)
}

fn last_toplevel_dot(source: &str) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut depth = 0i32;
    let mut last = None;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b'.' if depth == 0 => last = Some(index),
            _ => {}
        }
        index += 1;
    }
    last
}

fn ident_start(source: &str, end: usize) -> usize {
    let mut index = end;
    while index > 0 {
        let ch = source[..index].chars().next_back().unwrap();
        if !is_ident_char(ch) {
            break;
        }
        index -= ch.len_utf8();
    }
    index
}

pub(super) fn trailing_ident(prefix: &str) -> String {
    prefix
        .chars()
        .rev()
        .take_while(|ch| is_ident_char(*ch))
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

pub(super) fn is_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

pub(super) fn is_ident_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

mod alias;
mod tuple;

pub(crate) use alias::dispatch_alias_calls;
