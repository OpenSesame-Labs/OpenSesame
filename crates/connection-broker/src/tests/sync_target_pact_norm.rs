//! Lexical normalization for the credentialed sync pact scanner.
//! Comments, raw `r#` prefixes, and `use` items are stripped without looking
//! inside strings. Character literals (`'"'`, `b'"'`, `'\n'`) are skipped
//! before `"` opens a cooked string, so a quote cannot hide `request.send()`.
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
            index = skip_comment(bytes, index);
            out.push(' ');
            continue;
        }
        if noise && raw_ident_at(source, index) {
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
fn skip_comment(bytes: &[u8], start: usize) -> usize {
    if bytes.get(start + 1) == Some(&b'/') {
        let mut index = start + 2;
        while index < bytes.len() && bytes[index] != b'\n' {
            index += 1;
        }
        return index;
    }
    let mut index = start + 2;
    let mut depth = 1i32;
    while index + 1 < bytes.len() && depth > 0 {
        if bytes[index] == b'/' && bytes[index + 1] == b'*' {
            depth += 1;
            index += 2;
            continue;
        }
        if bytes[index] == b'*' && bytes[index + 1] == b'/' {
            depth -= 1;
            index += 2;
            continue;
        }
        index += 1;
    }
    if depth > 0 {
        bytes.len()
    } else {
        index
    }
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
fn is_ident_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
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
    let tree = tree.trim();
    if tree.is_empty() || tree == "*" {
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
    if tail == "response_guard" || (tail == "self" && guard) {
        modules.push(alias.to_string());
    } else if tail == "read_bounded_body" || (guard && tail != "self") {
        calls.push(alias.to_string());
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
fn split_use_as(item: &str) -> Option<(&str, &str)> {
    let bytes = item.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if is_keyword_at(bytes, index, b"as") {
            let alias_region = item[index + 2..].trim_start();
            let alias_len = alias_region
                .chars()
                .take_while(|ch| is_ident_char(*ch))
                .map(char::len_utf8)
                .sum::<usize>();
            if alias_len == 0 {
                return None;
            }
            return Some((item[..index].trim(), &alias_region[..alias_len]));
        }
        index += 1;
    }
    None
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
