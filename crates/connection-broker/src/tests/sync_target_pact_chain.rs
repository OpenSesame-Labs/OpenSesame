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
/// `let call = name` forwards the alias. `let (name,) = (Path::send,)` does too.
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
        if let Some((name, head_len)) = alias_forward_let(source, &aliases, &spans, index) {
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
    let name = let_name_before_path(source, index).or_else(|| tuple_binding_name(source, index))?;
    Some((name, head_len))
}

/// `let call = dispatch` when `dispatch` is already a send alias in this function.
fn alias_forward_let(
    source: &str,
    aliases: &[DispatchAlias],
    spans: &[(usize, usize)],
    index: usize,
) -> Option<(String, usize)> {
    let bytes = source.as_bytes();
    if index > 0 {
        let prev = bytes[index - 1];
        if is_ident_byte(prev) || prev == b'.' || prev == b':' {
            return None;
        }
    }
    let name = leading_ident(&source[index..]);
    if name.is_empty() {
        return None;
    }
    let mut after = &source[index + name.len()..];
    after = strip_turbofish(after).unwrap_or(after);
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
    if !terminator && !cast {
        return None;
    }
    let eq = eq_before(bytes, index)?;
    let (fn_start, _) = innermost_span(spans, index)?;
    let known = aliases
        .iter()
        .any(|alias| alias.fn_start == fn_start && alias.at < index && alias.name == name);
    if !known {
        return None;
    }
    let new_name = super::sync_target_pact_let::let_binding_name(source[..eq].trim_end())?;
    (new_name != name).then_some((new_name, name.len()))
}

fn eq_before(bytes: &[u8], index: usize) -> Option<usize> {
    let mut at = index;
    while at > 0 && bytes[at - 1].is_ascii_whitespace() {
        at -= 1;
    }
    if at == 0 || bytes[at - 1] != b'=' {
        return None;
    }
    let eq = at - 1;
    if matches!(
        eq.checked_sub(1).and_then(|prev| bytes.get(prev)),
        Some(b'=' | b'!' | b'<' | b'>')
    ) {
        return None;
    }
    Some(eq)
}

/// `let (dispatch,) = (Path::send,)` — the pattern element lines up with the function item.
fn tuple_binding_name(source: &str, head: usize) -> Option<String> {
    let path_start = path_prefix_start(source, head);
    let (open, element) = tuple_open_and_index(source, path_start)?;
    if open == 0 || source.as_bytes().get(open - 1) != Some(&b'=') {
        return None;
    }
    let eq = open - 1;
    if matches!(
        eq.checked_sub(1)
            .and_then(|prev| source.as_bytes().get(prev)),
        Some(b'=' | b'!' | b'<' | b'>')
    ) {
        return None;
    }
    let tail = statement_tail(&source[..eq]);
    let paren = tail.find('(')?;
    if !let_introduces_pattern(&tail[..paren]) {
        return None;
    }
    let inside = paren_inside(&tail[paren..])?;
    let elements = tuple_elements(inside);
    let elem = elements.get(element)?.trim();
    pattern_name(elem)
}

fn tuple_open_and_index(source: &str, path_start: usize) -> Option<(usize, usize)> {
    let bytes = source.as_bytes();
    if path_start == 0 {
        return None;
    }
    let mut index = path_start;
    let mut depth = 0i32;
    let mut commas = 0usize;
    while index > 0 {
        index -= 1;
        match bytes[index] {
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' | b'{' if depth > 0 => depth -= 1,
            b'(' if depth == 0 => return Some((index, commas)),
            b',' if depth == 0 => commas += 1,
            b'=' | b';' | b'{' if depth == 0 => return None,
            _ => {}
        }
    }
    None
}

fn statement_tail(lhs: &str) -> &str {
    let bytes = lhs.as_bytes();
    let mut depth = 0i32;
    let mut index = bytes.len();
    while index > 0 {
        index -= 1;
        match bytes[index] {
            b'>' if index > 0 && bytes[index - 1] == b'-' => {}
            b')' | b']' | b'>' => depth += 1,
            b'(' | b'[' | b'<' if depth > 0 => depth -= 1,
            b';' | b'{' if depth == 0 => return lhs[index + 1..].trim(),
            _ => {}
        }
    }
    lhs.trim()
}

fn paren_inside(at_paren: &str) -> Option<&str> {
    let bytes = at_paren.strip_prefix('(')?.as_bytes();
    let mut depth = 1i32;
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&at_paren[1..index + 1]);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn tuple_elements(inside: &str) -> Vec<&str> {
    let bytes = inside.as_bytes();
    let (mut depth, mut index, mut start) = (0i32, 0usize, 0usize);
    let mut out = Vec::new();
    while index < bytes.len() {
        match bytes[index] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' if depth > 0 => depth -= 1,
            b',' if depth == 0 => {
                out.push(inside[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    out.push(inside[start..].trim());
    out
}

fn pattern_name(elem: &str) -> Option<String> {
    let mut elem = elem.trim();
    if let Some(rest) = strip_kw(elem, "mut") {
        elem = rest;
    }
    if let Some(rest) = strip_kw(elem, "ref") {
        elem = rest;
        if let Some(rest) = strip_kw(elem, "mut") {
            elem = rest;
        }
    }
    let name: String = elem.chars().take_while(|ch| is_ident_char(*ch)).collect();
    if name.is_empty() || name == "_" {
        return None;
    }
    let rest = elem[name.len()..].trim_start();
    (rest.is_empty() || rest.starts_with(':')).then_some(name)
}

fn strip_kw<'a>(source: &'a str, keyword: &str) -> Option<&'a str> {
    let rest = source.strip_prefix(keyword)?;
    rest.chars()
        .next()
        .is_none_or(|ch| !is_ident_char(ch))
        .then(|| rest.trim_start())
}

/// `let (name,)` or `}let (name,)` after a previous block. `mut` may sit between.
fn let_introduces_pattern(before_paren: &str) -> bool {
    let before = before_paren.trim_end();
    if ends_with_kw(before, "let") {
        return true;
    }
    let Some(rest) = before.strip_suffix("mut") else {
        return false;
    };
    if rest.chars().next_back().is_some_and(is_ident_char) {
        return false;
    }
    ends_with_kw(rest.trim_end(), "let")
}

fn ends_with_kw(source: &str, keyword: &str) -> bool {
    source
        .strip_suffix(keyword)
        .is_some_and(|rest| rest.chars().next_back().is_none_or(|ch| !is_ident_char(ch)))
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
    if path_start > 0 && source.as_bytes()[path_start - 1] == b'=' {
        // Compacted `let name: Type =` — the type may itself contain `::`.
        return super::sync_target_pact_let::let_binding_name(source[..path_start - 1].trim_end());
    }
    super::sync_target_pact_let::typed_let_name_before_path(source, head)
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

fn leading_ident(source: &str) -> String {
    source.chars().take_while(|ch| is_ident_char(*ch)).collect()
}
