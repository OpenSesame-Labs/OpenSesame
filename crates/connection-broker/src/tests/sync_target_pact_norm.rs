//! Lexical normalization for the credentialed sync pact scanner.
//! Comments and raw `r#` prefixes are stripped without looking inside strings.
//! `r#use` is rewritten to `raw_use` so it stays an identifier: dropping `r#`
//! would turn it into the keyword `use`, and the import strip would delete
//! through the next `;` (including `response.text()`). A `use` path with no
//! `as` still aliases its last segment.

#[path = "sync_target_pact_lex.rs"]
mod lex;

pub(crate) use lex::{
    find_code_byte, function_spans, is_keyword_at, match_brace, non_code_len, string_len,
};
use lex::{is_ident_char, skip_block_comment_nested, skip_comment};

pub(crate) fn normalize_scan_source(source: &str) -> String {
    compact_source(&strip_use_items(&strip_noise(source)))
}

pub(crate) fn strip_noise(source: &str) -> String {
    rewrite(source, true)
}

fn strip_use_items(source: &str) -> String {
    rewrite(source, false)
}

fn rewrite(source: &str, noise: bool) -> String {
    let bytes = source.as_bytes();
    let mut out = String::with_capacity(source.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            out.push_str(&source[index..index + len]);
            index += len;
            continue;
        }
        if noise
            && index + 1 < bytes.len()
            && bytes[index] == b'/'
            && matches!(bytes[index + 1], b'/' | b'*')
        {
            index = if bytes[index + 1] == b'*' {
                skip_block_comment_nested(bytes, index)
            } else {
                skip_comment(bytes, index)
            };
            out.push(' ');
            continue;
        }
        if noise && raw_ident_at(source, index) {
            let ident = ident_at(&source[index + 2..]);
            if ident == "use" {
                out.push_str("raw_use");
                index += 2 + ident.len();
                continue;
            }
            index += 2;
            continue;
        }
        if !noise && is_keyword_at(bytes, index, b"use") {
            index = skip_until_semi(bytes, index);
            out.push(' ');
            continue;
        }
        let ch = source[index..].chars().next().unwrap();
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

pub(crate) fn skip_until_semi(bytes: &[u8], start: usize) -> usize {
    let mut index = start;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes[index] == b';' {
            return index + 1;
        }
        index += 1;
    }
    bytes.len()
}

fn raw_ident_at(source: &str, index: usize) -> bool {
    let bytes = source.as_bytes();
    if index + 2 >= bytes.len() || bytes[index] != b'r' || bytes[index + 1] != b'#' {
        return false;
    }
    if index > 0 && is_ident_char(source[..index].chars().next_back().unwrap()) {
        return false;
    }
    source[index + 2..]
        .chars()
        .next()
        .is_some_and(is_ident_char)
}

fn ident_at(source: &str) -> &str {
    let end = source
        .char_indices()
        .find(|(_, ch)| !is_ident_char(*ch))
        .map(|(index, _)| index)
        .unwrap_or(source.len());
    &source[..end]
}

pub(crate) fn response_reader_aliases(source: &str) -> (Vec<String>, Vec<String>) {
    let source = strip_noise(source);
    let bytes = source.as_bytes();
    let mut calls = Vec::new();
    let mut modules = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if is_keyword_at(bytes, index, b"use") {
            let end = skip_until_semi(bytes, index);
            let stmt = compact_source(source[index + 3..end.saturating_sub(1)].trim());
            walk_use_tree(&stmt, "", &mut calls, &mut modules);
            index = end;
            continue;
        }
        index += 1;
    }
    (calls, modules)
}

fn walk_use_tree(tree: &str, prefix: &str, calls: &mut Vec<String>, modules: &mut Vec<String>) {
    let mut tree = tree.trim();
    if tree.is_empty() {
        return;
    }
    if let Some(base) = tree.strip_suffix("::*") {
        walk_use_tree("*", base.trim_end_matches(':'), calls, modules);
        return;
    }
    if tree == "*" {
        if prefix.split("::").any(|seg| seg == "response_guard") {
            for sym in ["read_bounded_body", "safe_oauth_error_detail"] {
                if !calls.iter().any(|c| c == sym) {
                    calls.push(sym.to_string());
                }
            }
        }
        return;
    }
    if let Some((base, inner)) = split_use_group(tree) {
        let next = join_use_path(prefix, base);
        for item in split_use_items(inner) {
            walk_use_tree(item, &next, calls, modules);
        }
        return;
    }
    let Some((path, alias)) = split_use_as(tree) else {
        return;
    };
    let full = join_use_path(prefix, path.trim());
    let tail = full.rsplit("::").next().unwrap_or(full.as_str());
    let guard = full.split("::").any(|seg| seg == "response_guard");
    let scoped = scoped_alias(prefix, path, alias);
    if (tail == "response_guard" || (tail == "self" && guard)) && scoped != "self" {
        modules.push(scoped);
    } else if tail == "read_bounded_body" || (guard && tail != "self") {
        calls.push(scoped);
    }
}

/// `use path::{self}` brings the parent segment into scope, not the keyword `self`.
fn scoped_alias(prefix: &str, path: &str, alias: &str) -> String {
    if path.trim() == "self" && alias == "self" {
        return prefix
            .rsplit("::")
            .next()
            .filter(|seg| !seg.is_empty() && *seg != "self")
            .unwrap_or("self")
            .to_string();
    }
    alias.to_string()
}

fn join_use_path(prefix: &str, path: &str) -> String {
    let path = path.trim();
    if prefix.is_empty() || path.is_empty() {
        return format!("{prefix}{path}");
    }
    format!("{prefix}::{path}")
}

fn split_use_group(tree: &str) -> Option<(&str, &str)> {
    let bytes = tree.as_bytes();
    let mut index = 0usize;
    while index + 2 < bytes.len() {
        if &bytes[index..index + 3] == b"::{" {
            let close = match_brace(bytes, index + 2)?;
            return Some((tree[..index].trim(), tree[index + 3..close].trim()));
        }
        index += 1;
    }
    None
}

fn split_use_items(inner: &str) -> Vec<&str> {
    let mut items = Vec::new();
    let (mut start, mut depth) = (0usize, 0i32);
    for (index, byte) in inner.bytes().enumerate() {
        match byte {
            b'{' | b'(' | b'[' | b'<' => depth += 1,
            b'}' | b')' | b']' | b'>' => depth -= 1,
            b',' if depth == 0 => {
                push_use_item(&mut items, inner, start, index);
                start = index + 1;
            }
            _ => {}
        }
    }
    push_use_item(&mut items, inner, start, inner.len());
    items
}

fn push_use_item<'a>(items: &mut Vec<&'a str>, inner: &'a str, start: usize, end: usize) {
    let item = inner[start..end].trim();
    if !item.is_empty() {
        items.push(item);
    }
}

/// `path as alias`, or a bare path whose in-scope name is the last segment.
fn split_use_as(item: &str) -> Option<(&str, &str)> {
    let bytes = item.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if is_keyword_at(bytes, index, b"as") {
            let alias_region = item[index + 2..].trim_start();
            let alias_len = ident_at(alias_region).len();
            if alias_len > 0 && alias_region[alias_len..].trim().is_empty() {
                return Some((item[..index].trim(), &alias_region[..alias_len]));
            }
        }
        index += 1;
    }
    let path = item.trim();
    if path.is_empty() {
        return None;
    }
    let alias = path.rsplit("::").next()?.trim();
    (alias == ident_at(alias) && !alias.is_empty()).then_some((path, alias))
}

pub(crate) fn compact_source(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch.is_whitespace() {
            let prev_ident = out.chars().next_back().is_some_and(is_ident_char);
            let next_ident = chars.peek().copied().is_some_and(is_ident_char);
            if prev_ident && next_ident {
                out.push(' ');
            }
            continue;
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod probes {
    use super::super::sync_target_pact_scan::response_body_reads;

    fn reads(sample: &str) -> bool {
        !response_body_reads(sample).is_empty()
    }

    #[test]
    fn p5_raw_use_does_not_strip_body_read() {
        for sample in [
            "let r#use = response.text();",
            "r#use::read_bounded_body(&mut response, 1);",
            "fn f() { let r#use = response.bytes(); }",
            "response.r#text().await",
        ] {
            assert!(reads(sample), "{sample}");
        }
        assert!(!reads("let r#use = 1;"));
        assert!(!reads("let _ = \"r#use\"; let status = response.status();"));
    }

    #[test]
    fn p5_use_without_as_is_an_alias() {
        for sample in [
            "use response_guard::safe_oauth_error_detail; safe_oauth_error_detail(&err)",
            "use crate::response_guard::safe_oauth_error_detail;\nsafe_oauth_error_detail(&err)",
            "use crate::response_guard::{safe_oauth_error_detail};\nsafe_oauth_error_detail(&err)",
            "use crate::response_guard::safe_oauth_error_detail as detail;\ndetail(&err)",
        ] {
            assert!(reads(sample), "{sample}");
        }
        assert!(!reads("use serde_json::json;"));
        assert!(!reads(
            "use foo::safe_oauth_error_detail; safe_oauth_error_detail(&err)"
        ));
        assert!(reads(
            "use crate::response_guard::*; safe_oauth_error_detail(&err)"
        ));
    }
}
