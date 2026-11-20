//! Visible dispatch alias at a call site.
//!
//! A later `let` or assignment shadows an earlier send alias until that binding
//! ends. A `let` inside a block does not kill the outer alias after the block.
//! The establishing `let` does not shadow its own call, and a comment cannot
//! fake a rebind — including the alias name inside a `let (` pattern.

use super::super::super::sync_target_pact_norm::{is_keyword_at, non_code_len, skip_until_semi};
use super::{path_prefix_start, statement_tail, value_eq, DispatchAlias};

/// A later `let` or `name = …` rebinding shadows an earlier send alias.
/// Comments cannot fake that pattern, and the establishing `let` does not
/// shadow itself.
pub(super) fn alias_shadowed(source: &str, alias: &DispatchAlias, call: usize) -> bool {
    let bytes = source.as_bytes();
    let mut index = alias.at;
    if is_keyword_at(bytes, index, b"let") || establishing_let(source, index) {
        index = skip_until_semi(bytes, index);
    }
    let mut depth = 0i32;
    // Depths of `let` shadows still in scope. An assignment sticks only when
    // it targets the alias itself, not a block-local shadow.
    let mut let_depths: Vec<i32> = Vec::new();
    let mut assigned = false;
    while index < call {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' => depth += 1,
            b'}' if depth > 0 => {
                depth -= 1;
                while let_depths.last().is_some_and(|live| *live > depth) {
                    let_depths.pop();
                }
            }
            _ if rebind_at(source, bytes, index, &alias.name) => {
                if is_keyword_at(bytes, index, b"let") {
                    let_depths.push(depth);
                } else if let_depths.is_empty() {
                    assigned = true;
                }
            }
            _ => {}
        }
        index += 1;
    }
    assigned || !let_depths.is_empty()
}

/// `let name = …::send` introduces the alias. A `let` inside that initializer
/// is not a later rebind of the name.
fn establishing_let(source: &str, head: usize) -> bool {
    let path_start = path_prefix_start(source, head);
    let Some(eq) = value_eq(source.as_bytes(), path_start) else {
        return false;
    };
    let tail = statement_tail(source[..eq].trim_end()).trim_start();
    is_keyword_at(tail.as_bytes(), 0, b"let")
}

fn rebind_at(source: &str, bytes: &[u8], index: usize, name: &str) -> bool {
    if is_keyword_at(bytes, index, b"let") {
        return let_rebinds_name(source, bytes, index, name);
    }
    ident_then_single_eq(bytes, index, name)
}

/// `name = …` starting at `index`. `==`, `=>`, and `+=` are not rebinds.
fn ident_then_single_eq(bytes: &[u8], index: usize, name: &str) -> bool {
    if !is_keyword_at(bytes, index, name.as_bytes()) {
        return false;
    }
    let mut at = index + name.len();
    while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
        at += 1;
    }
    bytes.get(at) == Some(&b'=') && !matches!(bytes.get(at + 1), Some(b'=' | b'>'))
}

fn let_rebinds_name(source: &str, bytes: &[u8], index: usize, name: &str) -> bool {
    let mut at = index + 3;
    while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
        at += 1;
    }
    if is_keyword_at(bytes, at, b"mut") {
        at += 3;
        while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
            at += 1;
        }
    }
    if bytes.get(at) == Some(&b'(') {
        let Some(close) = let_pattern_close(bytes, at) else {
            return false;
        };
        return pattern_contains_name(&source[at..=close], name);
    }
    let start = at;
    while at < bytes.len() && super::super::is_ident_byte(bytes[at]) {
        at += 1;
    }
    &source[start..at] == name
}

/// Closing `)` of a `let (` / `let mut (` pattern. Nested parens count.
/// Strings and comments are not code, so a `)` inside them does not close.
fn let_pattern_close(bytes: &[u8], open: usize) -> Option<usize> {
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
        if bytes[index] == b'(' {
            depth += 1;
        } else if bytes[index] == b')' {
            depth -= 1;
            if depth == 0 {
                return Some(index);
            }
        }
        index += 1;
    }
    None
}

/// `name` as a pattern ident. A comment or string inside `let (` is not a rebind.
fn pattern_contains_name(pattern: &str, name: &str) -> bool {
    let bytes = pattern.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if is_keyword_at(bytes, index, name.as_bytes()) {
            return true;
        }
        index += 1;
    }
    false
}
