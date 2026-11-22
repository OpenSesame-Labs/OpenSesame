//! Stream markers are body reads only when the receiver is the response.
//!
//! `entries.iter().for_each(...)` is not a provider-body read. `response.for_each`,
//! `StreamExt::for_each(response, ...)`, and `body.try_collect()` are.

use super::super::sync_target_pact_chain::{call_root_is_response, first_arg_is_response};
use super::super::sync_target_pact_norm::string_len;
use super::super::sync_target_pact_rename::strip_turbofish;
use super::is_ident_char;

const DOT_METHODS: &[&str] = &[
    "next",
    "try_next",
    "poll_next",
    "poll_next_unpin",
    "try_poll_next_unpin",
    "for_each",
    "fold",
    "try_fold",
    "collect",
    "count",
    "try_collect",
    "try_for_each",
];

const UFCS_METHODS: &[&str] = &[
    "next",
    "try_next",
    "poll_next_unpin",
    "try_poll_next_unpin",
    "for_each",
    "fold",
    "try_fold",
    "collect",
    "count",
    "try_collect",
    "try_for_each",
];

pub(super) fn on_response(scanned: &str) -> bool {
    dot_on_response(scanned) || ufcs_on_response(scanned)
}

fn dot_on_response(scanned: &str) -> bool {
    let bytes = scanned.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes[index] == b'.' && dot_method_hit(scanned, index) {
            return true;
        }
        index += 1;
    }
    false
}

fn dot_method_hit(scanned: &str, dot: usize) -> bool {
    let rest = &scanned[dot + 1..];
    DOT_METHODS
        .iter()
        .any(|method| method_call(rest, method).is_some() && call_root_is_response(scanned, dot))
}

fn ufcs_on_response(scanned: &str) -> bool {
    let bytes = scanned.as_bytes();
    let mut index = 0usize;
    while index + 1 < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if scanned[index..].starts_with("::") && ufcs_hit(scanned, index) {
            return true;
        }
        index += 1;
    }
    false
}

fn ufcs_hit(scanned: &str, colons: usize) -> bool {
    let rest = &scanned[colons + 2..];
    UFCS_METHODS.iter().any(|method| {
        let Some(open) = method_call(rest, method) else {
            return false;
        };
        first_arg_is_response(scanned, colons + 2 + open)
    })
}

/// Byte offset of `(` after `method` and an optional turbofish, within `rest`.
fn method_call(rest: &str, method: &str) -> Option<usize> {
    let after = rest.strip_prefix(method)?;
    if after.chars().next().is_some_and(is_ident_char) {
        return None;
    }
    let trimmed = after.trim_start();
    let peeled = strip_turbofish(trimmed);
    peeled.starts_with('(').then_some(rest.len() - peeled.len())
}
