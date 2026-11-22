//! Response-receiver stream chains for the credentialed sync pact.
//!
//! `response.map(...).collect()`, `response.map(...)?.collect()`,
//! `StreamExt::map(response, ...).collect()`, and `(&mut response).count()`
//! consume the body even though the terminator's immediate receiver is not
//! `response`.

use super::sync_target_pact_norm::non_code_len;

mod args;
use args::{first_arg, matching_open_paren, place_ident};

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
        // Body-consuming terminators drain the stream like `collect`.
        "fold",
        "try_fold",
        "try_collect",
        "try_for_each",
        "all",
        "nth",
        // Search terminators (`position`, `find_map`) and numeric folds
        // (`sum`, `product`) drain the stream the same way.
        "position",
        "find_map",
        "sum",
        "product",
        // Extrema terminators inspect every element.
        "max",
        "min",
        "max_by",
        "max_by_key",
        "min_by",
        "min_by_key",
        // Ordering comparisons and reductions consume the whole stream.
        "cmp",
        "partial_cmp",
        "eq",
        "ne",
        "lt",
        "le",
        "gt",
        "ge",
        "reduce",
        "unzip",
        "for_each",
    ];
    METHODS
        .iter()
        .any(|method| chain_method_on_response(scanned, method))
}

/// `.for_each(` / `.try_next(` rooted on a credentialed response.
pub(crate) fn call_root_is_response(source: &str, dot: usize) -> bool {
    chain_root_is_response(source, dot)
}

/// First argument of the call opened at `open` is a response receiver.
pub(crate) fn first_arg_is_response(source: &str, open: usize) -> bool {
    let Some(arg) = first_arg(source, open) else {
        return false;
    };
    let Some(name) = place_ident(arg) else {
        return false;
    };
    let Some(rel) = arg.find(&name) else {
        return false;
    };
    let at = arg.as_ptr() as usize - source.as_ptr() as usize + rel;
    super::sync_target_pact_rename::tracks_response_receiver(source, at, name)
}

fn chain_method_on_response(scanned: &str, method: &str) -> bool {
    let bytes = scanned.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes[index] == b'.'
            && method_after_dot(scanned, index, method)
            && chain_root_is_response(scanned, index)
        {
            return true;
        }
        index += 1;
    }
    false
}

/// `./*c*/collect(` and `.collect::<T>(`. Comments may sit between `.` and the name.
fn method_after_dot(source: &str, dot: usize, method: &str) -> bool {
    let bytes = source.as_bytes();
    let name_at = skip_noise(bytes, dot + 1);
    let Some(rest) = source.get(name_at..) else {
        return false;
    };
    if !rest.starts_with(method) {
        return false;
    }
    let after = name_at + method.len();
    if bytes.get(after).is_some_and(|byte| is_ident_byte(*byte)) {
        return false;
    }
    let tail = skip_noise(bytes, after);
    bytes.get(tail) == Some(&b'(')
        || source
            .get(tail..)
            .is_some_and(|rest| rest.starts_with("::"))
}

fn skip_noise(bytes: &[u8], mut index: usize) -> usize {
    loop {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
            index += 1;
            continue;
        }
        return index;
    }
}

fn chain_root_is_response(source: &str, dot: usize) -> bool {
    root_ident(source, dot).is_some_and(|name| {
        super::sync_target_pact_rename::tracks_response_receiver(source, dot, name)
    })
}

fn root_ident(source: &str, mut end: usize) -> Option<String> {
    loop {
        end = skip_chain_postfix(source, end);
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
            let before_name = skip_gap_back(bytes, name_start);
            if before_name > 0 && bytes[before_name - 1] == b'.' {
                end = before_name - 1;
                continue;
            }
            if let Some(name) = ufcs_chain_receiver(source, name_start, open) {
                return Some(name);
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

/// `?`, `.await`, and comments sit between the receiver and the next chain method.
fn skip_chain_postfix(source: &str, mut end: usize) -> usize {
    let bytes = source.as_bytes();
    loop {
        while end > 0 && bytes[end - 1].is_ascii_whitespace() {
            end -= 1;
        }
        let skipped = skip_noise_back(bytes, end);
        if skipped < end {
            end = skipped;
            continue;
        }
        if end > 0 && bytes[end - 1] == b'?' {
            end -= 1;
            continue;
        }
        if end >= 6 && source.get(end - 6..end) == Some(".await") {
            end -= 6;
            continue;
        }
        return end;
    }
}

/// Byte before `name`, skipping comments and whitespace (`./*c*/map`).
fn skip_gap_back(bytes: &[u8], mut end: usize) -> usize {
    loop {
        while end > 0 && bytes[end - 1].is_ascii_whitespace() {
            end -= 1;
        }
        let skipped = skip_noise_back(bytes, end);
        if skipped < end {
            end = skipped;
            continue;
        }
        return end;
    }
}

/// Start of a comment or string that ends at `end`, otherwise `end`.
fn skip_noise_back(bytes: &[u8], end: usize) -> usize {
    let mut index = 0usize;
    while index < end {
        if let Some(len) = non_code_len(bytes, index) {
            let span_end = index + len;
            if span_end >= end {
                return index;
            }
            index = span_end.max(index + 1);
            continue;
        }
        index += 1;
    }
    end
}

/// `StreamExt::map(response, …)` — the receiver is the first argument.
fn ufcs_chain_receiver(source: &str, name_start: usize, open: usize) -> Option<String> {
    if name_start < 2 || &source.as_bytes()[name_start - 2..name_start] != b"::" {
        return None;
    }
    place_ident(first_arg(source, open)?)
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
        if let Some(len) = non_code_len(bytes, index) {
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
mod peel;
mod tuple;

pub(crate) use alias::dispatch_alias_calls;

#[path = "chain_probes.rs"]
#[cfg(test)]
mod probes;
