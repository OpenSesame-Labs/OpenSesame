//! `{response}.into()` block-tail reads.
use super::super::sync_target_pact_norm::string_len;
use super::super::sync_target_pact_rename;

pub(super) fn block_into_read(scanned: &str) -> bool {
    each_code_marker(scanned, ".into", block_into_at)
}

fn block_into_at(scanned: &str, index: usize) -> bool {
    let after = &scanned[index + ".into".len()..];
    if after.chars().next().is_some_and(super::is_ident_char) {
        return false;
    }
    let after = sync_target_pact_rename::strip_turbofish(after);
    if !after.starts_with('(') {
        return false;
    }
    let prefix = scanned[..index].trim_end();
    if !prefix.ends_with('}') {
        return false;
    }
    let close = prefix.len() - 1;
    let Some(open) = matching_block_open(prefix, close) else {
        return false;
    };
    let inner = &prefix[open + 1..close];
    let (tail_at, tail) = block_tail(inner);
    let Some(name) = sync_target_pact_rename::plain_name(tail) else {
        return false;
    };
    let at = open + 1 + tail_at + name_in(tail, &name);
    sync_target_pact_rename::tracks_response_receiver(scanned, at, name)
}

/// `{` that pairs with the `}` immediately before `.into()`, not an inner block.
fn matching_block_open(source: &str, close: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    if bytes.get(close) != Some(&b'}') {
        return None;
    }
    let mut stack = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() && index <= close {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' => stack.push(index),
            b'}' => {
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

/// Tail expression of a block body. Statements before the last depth-0 `;` are not the value.
fn block_tail(inner: &str) -> (usize, &str) {
    let bytes = inner.as_bytes();
    let mut depth = 0i32;
    let mut index = 0usize;
    let mut semi = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' | b'(' | b'[' => depth += 1,
            b'}' | b')' | b']' if depth > 0 => depth -= 1,
            b';' if depth == 0 => semi = index + 1,
            _ => {}
        }
        index += 1;
    }
    let rest = &inner[semi..];
    let lead = rest.len() - rest.trim_start().len();
    (semi + lead, rest.trim())
}

fn name_in(tail: &str, name: &str) -> usize {
    let lead = tail.len() - tail.trim_start().len();
    let within = tail.trim_start();
    lead + within.find(name).unwrap_or(0)
}

fn each_code_marker(scanned: &str, marker: &str, mut hit: impl FnMut(&str, usize) -> bool) -> bool {
    let bytes = scanned.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if scanned[index..].starts_with(marker) && hit(scanned, index) {
            return true;
        }
        index += 1;
    }
    false
}
