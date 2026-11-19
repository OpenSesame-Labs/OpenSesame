//! Response-receiver stream chains for the credentialed sync pact.
//!
//! `response.map(...).collect()` and `(&mut response).count()` consume the
//! body even though the terminator's immediate receiver is not `response`.

use super::sync_target_pact_norm::{function_spans, string_len};

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
    root_ident(source, dot)
        .is_some_and(|name| super::sync_target_pact_rename::tracks_response_receiver(source, dot, name))
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

fn trailing_ident(prefix: &str) -> String {
    prefix
        .chars()
        .rev()
        .take_while(|ch| is_ident_char(*ch))
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn is_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn is_ident_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

/// `(call_index, ident_len)` for `let name = Path::{send,execute}` function items.
/// The binding is not a dispatch; only a later `name(…)` in that function is.
pub(crate) fn dispatch_alias_calls(source: &str) -> Vec<(usize, usize)> {
    let bytes = source.as_bytes();
    let spans = function_spans(bytes);
    let mut aliases = Vec::new();
    let mut calls = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if !source.is_char_boundary(index) {
            index += 1;
            continue;
        }
        if let Some((name, head_len)) = function_item_let(source, index) {
            if let Some((fn_start, _)) = innermost_span(&spans, index) {
                aliases.push(DispatchAlias {
                    fn_start,
                    at: index,
                    name,
                });
            }
            index += head_len;
            continue;
        }
        if let Some(len) = alias_call_len(source, &aliases, &spans, index) {
            calls.push((index, len));
            index += len;
            continue;
        }
        index += 1;
    }
    calls
}

struct DispatchAlias {
    fn_start: usize,
    at: usize,
    name: String,
}

fn function_item_let(source: &str, index: usize) -> Option<(String, usize)> {
    let head_len = function_item_head(source, index)?;
    Some((let_name_before_path(source, index)?, head_len))
}

fn function_item_head(source: &str, index: usize) -> Option<usize> {
    let rest = &source[index..];
    const HEADS: &[&str] = &["::execute", "::send", ".execute", ".send"];
    let head = HEADS.iter().copied().find(|head| rest.starts_with(head))?;
    if head.starts_with('.') && index > 0 && source.as_bytes()[index - 1] == b':' {
        return None;
    }
    let after = &rest[head.len()..];
    if after.chars().next().is_some_and(is_ident_char) {
        return None;
    }
    let after = strip_turbofish(after).unwrap_or(after).trim_start();
    if after.starts_with('(') {
        return None;
    }
    let next = after.chars().next();
    let terminator = matches!(next, Some(';' | ')' | ',' | ']' | '}') | None);
    let cast = after.starts_with("as")
        && after[2..]
            .chars()
            .next()
            .is_none_or(|ch| !is_ident_char(ch));
    (terminator || cast).then_some(head.len())
}

fn let_name_before_path(source: &str, head: usize) -> Option<String> {
    let path_start = path_prefix_start(source, head);
    if path_start == 0 || source.as_bytes()[path_start - 1] != b'=' {
        return super::sync_target_pact_rename::typed_let_name_before_path(source, head);
    }
    let name = trailing_ident(&source[..path_start - 1]);
    if name.is_empty() || name == "_" {
        return super::sync_target_pact_rename::typed_let_name_before_path(source, head);
    }
    let before = source[..path_start - 1 - name.len()].trim_end();
    let before = if ends_with_kw(before, "mut") {
        before[..before.len() - 3].trim_end()
    } else {
        before
    };
    ends_with_kw(before, "let").then_some(name)
}

fn path_prefix_start(source: &str, head: usize) -> usize {
    let mut index = head;
    let mut angle = 0i32;
    while index > 0 {
        let ch = source[..index].chars().next_back().unwrap();
        if angle > 0 {
            angle += match ch {
                '<' => -1,
                '>' => 1,
                _ => 0,
            };
            index -= ch.len_utf8();
            continue;
        }
        if ch == '>' {
            angle = 1;
            index -= ch.len_utf8();
            continue;
        }
        if is_ident_char(ch) || ch == ':' {
            index -= ch.len_utf8();
            continue;
        }
        break;
    }
    index
}

fn alias_call_len(
    source: &str,
    aliases: &[DispatchAlias],
    spans: &[(usize, usize)],
    index: usize,
) -> Option<usize> {
    if index > 0 {
        let prev = source.as_bytes()[index - 1];
        if is_ident_byte(prev) || prev == b'.' || prev == b':' {
            return None;
        }
    }
    let name = leading_ident(&source[index..]);
    if name.is_empty() {
        return None;
    }
    let mut after =
        strip_turbofish(&source[index + name.len()..]).unwrap_or(&source[index + name.len()..]);
    while after.starts_with(')') {
        after = &after[1..];
        after = strip_turbofish(after).unwrap_or(after);
    }
    if !after.starts_with('(') {
        return None;
    }
    let (fn_start, _) = innermost_span(spans, index)?;
    aliases
        .iter()
        .any(|alias| alias.fn_start == fn_start && alias.at < index && alias.name == name)
        .then_some(name.len())
}

fn innermost_span(spans: &[(usize, usize)], index: usize) -> Option<(usize, usize)> {
    spans
        .iter()
        .copied()
        .filter(|(start, end)| *start < index && index < *end)
        .min_by_key(|(start, end)| end - start)
}

fn strip_turbofish(after: &str) -> Option<&str> {
    let after = after.strip_prefix("::")?.strip_prefix('<')?;
    let mut depth = 1i32;
    for (index, ch) in after.char_indices() {
        match ch {
            '<' => depth += 1,
            '>' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&after[index + ch.len_utf8()..]);
                }
            }
            _ => {}
        }
    }
    None
}

fn ends_with_kw(source: &str, keyword: &str) -> bool {
    source
        .strip_suffix(keyword)
        .is_some_and(|rest| rest.chars().next_back().is_none_or(|ch| !is_ident_char(ch)))
}

fn leading_ident(source: &str) -> String {
    source.chars().take_while(|ch| is_ident_char(*ch)).collect()
}


