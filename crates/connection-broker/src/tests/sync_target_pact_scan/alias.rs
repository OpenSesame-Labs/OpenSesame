//! `use`-driven type aliases of `Response` and the UFCS path that names a type.
//!
//! `use reqwest::Response as Resp` makes `Resp::text(response)` a body read.
//! The alias table walks `use` trees (groups, `as`, bare paths, `::*`) before
//! the `use` items themselves are stripped from the scanned source.
use super::super::sync_target_pact_norm::{
    compact_source, is_keyword_at, match_brace, non_code_len, skip_until_semi, strip_noise,
};

/// In-scope names introduced by `use …::Response as Alias`.
pub(super) fn response_type_aliases(source: &str) -> Vec<String> {
    let source = strip_noise(source);
    let bytes = source.as_bytes();
    let mut aliases = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if is_keyword_at(bytes, index, b"use") {
            let end = skip_until_semi(bytes, index);
            let stmt_end = stmt_end_before_semi(bytes, end);
            let stmt = compact_source(source[index + 3..stmt_end].trim());
            push_response_aliases(&stmt, "", &mut aliases);
            index = end;
            continue;
        }
        index += 1;
    }
    aliases
}

/// Type expression immediately before `::method`, including `<...>` groups.
pub(super) fn ufcs_type_path(prefix: &str) -> &str {
    let mut index = prefix.len();
    let mut angle_depth = 0i32;
    while index > 0 {
        let ch = char_before(&prefix[..index]);
        let ch_len = ch.len_utf8();
        if angle_depth > 0 {
            if ch == '>' {
                angle_depth += 1;
            } else if ch == '<' {
                angle_depth -= 1;
            }
            index -= ch_len;
            continue;
        }
        if super::is_ident_char(ch) {
            index -= ch_len;
            continue;
        }
        if ch == '>' {
            angle_depth += 1;
            index -= ch_len;
            continue;
        }
        if ch == ':' && prefix[..index - ch_len].ends_with(':') {
            index -= ch_len + ':'.len_utf8();
            continue;
        }
        break;
    }
    &prefix[index..]
}

fn stmt_end_before_semi(bytes: &[u8], end: usize) -> usize {
    if end > 0 && bytes.get(end - 1) == Some(&b';') {
        end - 1
    } else {
        end
    }
}

fn push_response_aliases(tree: &str, prefix: &str, aliases: &mut Vec<String>) {
    let tree = tree.trim();
    if tree.is_empty() || tree == "*" {
        return;
    }
    if let Some((base, inner)) = split_use_group(tree) {
        let next = join_use_path(prefix, base);
        for item in split_use_items(inner) {
            push_response_aliases(item, &next, aliases);
        }
        return;
    }
    let (path, alias) = split_use_as(tree);
    let full = join_use_path(prefix, path);
    let tail = full.rsplit("::").next().unwrap_or(full.as_str()).trim();
    if tail == "Response" && !alias.is_empty() {
        aliases.push(alias.to_string());
    }
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
        if bytes[index..].starts_with(b"::{") {
            let close = match_brace(bytes, index + 2)?;
            return Some((tree[..index].trim(), tree[index + 3..close].trim()));
        }
        index += 1;
    }
    None
}

fn split_use_items(inner: &str) -> Vec<&str> {
    let (mut start, mut depth) = (0usize, 0i32);
    let mut items = Vec::new();
    for (index, byte) in inner.bytes().enumerate() {
        match byte {
            b'{' | b'(' | b'[' | b'<' => depth += 1,
            b'}' | b')' | b']' | b'>' => depth -= 1,
            b',' if depth == 0 => {
                let item = inner[start..index].trim();
                if !item.is_empty() {
                    items.push(item);
                }
                start = index + 1;
            }
            _ => {}
        }
    }
    let item = inner[start..].trim();
    if !item.is_empty() {
        items.push(item);
    }
    items
}

fn split_use_as(item: &str) -> (&str, &str) {
    let bytes = item.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if is_keyword_at(bytes, index, b"as") {
            let alias_region = item[index + 2..].trim_start();
            let alias = ident_at(alias_region);
            if !alias.is_empty() && alias_region[alias.len()..].trim().is_empty() {
                return (item[..index].trim(), alias);
            }
        }
        index += 1;
    }
    let path = item.trim();
    let alias = path.rsplit("::").next().unwrap_or(path).trim();
    (path, alias)
}

fn ident_at(source: &str) -> &str {
    let end = source
        .char_indices()
        .find(|(_, ch)| !super::is_ident_char(*ch))
        .map(|(index, _)| index)
        .unwrap_or(source.len());
    &source[..end]
}

fn char_before(prefix: &str) -> char {
    prefix.chars().next_back().unwrap_or('\0')
}

#[cfg(test)]
mod probes {
    use super::response_type_aliases;

    #[test]
    fn council_r4_response_aliases_cover_groups_and_globs() {
        let src = "use reqwest::Response as Resp;\nuse reqwest::{Response, RequestBuilder};\nuse crate::response_guard::*;\nResp::text(response)";
        let aliases = response_type_aliases(src);
        assert!(aliases.iter().any(|alias| alias == "Resp"), "{aliases:?}");
        assert!(
            aliases.iter().any(|alias| alias == "Response"),
            "{aliases:?}"
        );
        assert!(
            !aliases.iter().any(|alias| alias == "RequestBuilder"),
            "{aliases:?}"
        );
    }
}
