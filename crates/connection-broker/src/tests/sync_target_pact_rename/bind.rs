//! `let`/`=` bindings and tuple patterns.
use super::super::sync_target_pact_norm::{is_keyword_at, string_len};
use super::marker::{find_marker, is_ident_byte, is_ident_char};
use super::peel::{match_delim, strip_ref, trailing_ident, unwrap_parens, unwrap_value};

pub(super) fn let_bind_rhs(prefix: &str, name: &str) -> Option<String> {
    let bytes = prefix.as_bytes();
    let mut index = 0usize;
    let mut found = None;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if is_keyword_at(bytes, index, b"let") {
            if let Some(rhs) = let_named_rhs(prefix, bytes, index, name) {
                found = Some(rhs);
            }
        } else if is_keyword_at(bytes, index, name.as_bytes()) {
            if let Some(rhs) = assign_rhs(prefix, bytes, index + name.len()) {
                found = Some(rhs);
            }
        }
        index += 1;
    }
    found
}

fn let_named_rhs(prefix: &str, bytes: &[u8], index: usize, name: &str) -> Option<String> {
    let mut at = skip_ws(bytes, index + 3);
    if is_keyword_at(bytes, at, b"mut") {
        at = skip_ws(bytes, at + 3);
    }
    if bytes.get(at) == Some(&b'(') {
        return let_tuple_named_rhs(prefix, bytes, at, name);
    }
    let bind = read_ident_at(prefix, at)?;
    at = skip_ws(bytes, at + bind.len());
    if bytes.get(at) == Some(&b':') && bytes.get(at + 1) != Some(&b':') {
        at = skip_ws(bytes, skip_type(bytes, at + 1));
    }
    if !is_single_eq(bytes, at) || bind != name {
        return None;
    }
    rhs_ident(prefix, skip_ws(bytes, at + 1))
}

fn assign_rhs(prefix: &str, bytes: &[u8], at: usize) -> Option<String> {
    let at = skip_ws(bytes, at);
    if !is_single_eq(bytes, at) {
        return None;
    }
    rhs_ident(prefix, skip_ws(bytes, at + 1))
}

fn skip_ws(bytes: &[u8], mut at: usize) -> usize {
    while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
        at += 1;
    }
    at
}

pub(super) fn param_is_response(prefix: &str, name: &str) -> bool {
    let bytes = prefix.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if typed_param_is_response(prefix, bytes, index, name) {
            return true;
        }
        index += 1;
    }
    false
}

fn typed_param_is_response(prefix: &str, bytes: &[u8], index: usize, name: &str) -> bool {
    if !is_keyword_at(bytes, index, name.as_bytes()) || !param_slot(prefix, index) {
        return false;
    }
    let at = skip_ws(bytes, index + name.len());
    if bytes.get(at) != Some(&b':') || bytes.get(at + 1) == Some(&b':') {
        return false;
    }
    let end = skip_type(bytes, at + 1);
    type_is_response(&prefix[at + 1..end])
}

fn param_slot(source: &str, name_at: usize) -> bool {
    let before = source[..name_at].trim_end();
    ends_param(before) || mut_param(before)
}

fn ends_param(before: &str) -> bool {
    matches!(before.chars().next_back(), Some('(' | ',' | '|'))
}

fn mut_param(before: &str) -> bool {
    let Some(rest) = before.strip_suffix("mut") else {
        return false;
    };
    !rest.chars().next_back().is_some_and(is_ident_char) && ends_param(rest.trim_end())
}

fn type_is_response(ty: &str) -> bool {
    let mut ty = ty.trim();
    loop {
        if let Some(rest) = ty.strip_prefix('&') {
            ty = strip_mut_kw(rest.trim_start());
            continue;
        }
        if ty.starts_with('(') {
            let next = unwrap_parens(ty);
            if next.len() == ty.len() {
                break;
            }
            ty = next.trim();
            continue;
        }
        break;
    }
    trailing_ident(strip_generics(ty.trim())).as_deref() == Some("Response")
}

fn strip_generics(ty: &str) -> &str {
    let bytes = ty.as_bytes();
    if bytes.last() != Some(&b'>') {
        return ty;
    }
    let mut depth = 0i32;
    let mut index = bytes.len();
    while index > 0 {
        index -= 1;
        match bytes[index] {
            b'>' => depth += 1,
            b'<' => {
                depth -= 1;
                if depth == 0 {
                    return ty[..index].trim_end();
                }
            }
            _ => {}
        }
    }
    ty
}

fn strip_mut_kw(ty: &str) -> &str {
    if let Some(rest) = ty.strip_prefix("mut") {
        if rest.chars().next().is_none_or(|ch| !is_ident_char(ch)) {
            return rest.trim_start();
        }
    }
    ty
}

fn rhs_ident(source: &str, at: usize) -> Option<String> {
    let raw = source.get(at..)?;
    let lead = raw.len() - raw.trim_start().len();
    let trimmed = &raw[lead..];
    let expr = strip_ref(unwrap_value(trimmed));
    let expr_at = at + lead + slice_offset(trimmed, expr);
    if matches!(read_ident_at(expr, 0).as_deref(), Some("if" | "match")) {
        if let Some(name) = branch_response(source, expr, expr_at) {
            return Some(name);
        }
    }
    if credentialed_send_expr(expr) {
        return Some("response".to_string());
    }
    read_ident_at(expr, 0)
}

fn slice_offset(outer: &str, inner: &str) -> usize {
    inner.as_ptr() as usize - outer.as_ptr() as usize
}

/// An `if` / `match` initializer aliases the response when any branch value does.
fn branch_response(source: &str, expr: &str, expr_at: usize) -> Option<String> {
    let bytes = expr.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if !is_ident_byte(bytes[index]) {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len() && is_ident_byte(bytes[index]) {
            index += 1;
        }
        let name = &expr[start..index];
        if tracks_branch_ident(source, expr_at + start, name) {
            return Some(name.to_string());
        }
    }
    None
}

fn tracks_branch_ident(source: &str, at: usize, name: &str) -> bool {
    if matches!(name, "if" | "else" | "match" | "return" | "async") {
        return false;
    }
    super::tracks_response_receiver(source, at, name.to_string())
}

fn credentialed_send_expr(expr: &str) -> bool {
    send_marker(expr, ".send")
        || send_marker(expr, "::send")
        || (!expr.contains("sqlx::")
            && (send_marker(expr, ".execute") || send_marker(expr, "::execute")))
}

fn send_marker(expr: &str, marker: &str) -> bool {
    find_marker(expr, marker, |index| {
        !expr[index + marker.len()..]
            .chars()
            .next()
            .is_some_and(is_ident_char)
    })
}

fn let_tuple_named_rhs(prefix: &str, bytes: &[u8], pat_open: usize, name: &str) -> Option<String> {
    let pattern_close = match_delim(&prefix[pat_open..], b'(', b')')?;
    let pattern = &prefix[pat_open + 1..pat_open + pattern_close];
    if !tuple_pattern_binds(pattern, name) {
        return None;
    }
    let mut at = skip_ws(bytes, pat_open + pattern_close + 1);
    if bytes.get(at) == Some(&b':') && bytes.get(at + 1) != Some(&b':') {
        at = skip_ws(bytes, skip_type(bytes, at + 1));
    }
    if !is_single_eq(bytes, at) {
        return None;
    }
    let rhs_at = skip_ws(bytes, at + 1);
    let rhs = prefix.get(rhs_at..)?.trim_start();
    if let Some(inside) = unwrap_tuple_rhs(rhs) {
        if let Some(path) = tuple_bind_path(pattern, name) {
            return plain_name(descend_tuple_rhs(inside, &path));
        }
    }
    rhs_ident(prefix, rhs_at)
}

fn unwrap_tuple_rhs(rhs: &str) -> Option<&str> {
    let rhs = unwrap_value(rhs);
    match_delim(rhs, b'(', b')').map(|close| rhs[1..close].trim())
}

fn tuple_bind_path(pattern: &str, name: &str) -> Option<Vec<usize>> {
    let inside = pattern.trim();
    let inside = inside
        .strip_prefix('(')
        .and_then(|rest| rest.strip_suffix(')'))
        .unwrap_or(inside);
    for (index, part) in tuple_split(inside).into_iter().enumerate() {
        if tuple_pattern_binds(part, name) {
            return Some(vec![index]);
        }
        let nested = part
            .trim()
            .strip_prefix('(')
            .and_then(|rest| rest.strip_suffix(')'));
        if let Some(inner) = nested {
            if let Some(mut path) = tuple_bind_path(inner, name) {
                path.insert(0, index);
                return Some(path);
            }
        }
    }
    None
}

fn descend_tuple_rhs<'a>(inside: &'a str, path: &[usize]) -> &'a str {
    let mut piece = inside.trim();
    for &index in path {
        let Some(next) = unwrap_tuple_rhs(piece) else {
            return "";
        };
        piece = tuple_split(next).get(index).copied().unwrap_or("").trim();
    }
    piece
}

fn tuple_split(inside: &str) -> Vec<&str> {
    let bytes = inside.as_bytes();
    let (mut depth, mut index, mut start) = (0i32, 0usize, 0usize);
    let mut out = Vec::new();
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
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

fn tuple_pattern_binds(elem: &str, name: &str) -> bool {
    let elem = elem.trim();
    let elem = elem.strip_prefix("mut ").unwrap_or(elem).trim();
    if let Some(inner) = elem
        .strip_prefix('(')
        .and_then(|rest| rest.strip_suffix(')'))
    {
        return tuple_split(inner)
            .iter()
            .any(|part| !part.is_empty() && tuple_pattern_binds(part, name));
    }
    read_ident_at(elem, 0).as_deref() == Some(name) && elem[name.len()..].trim().is_empty()
        || elem.starts_with(name) && elem[name.len()..].trim_start().starts_with(':')
}

pub(crate) fn plain_name(expr: &str) -> Option<String> {
    let expr = strip_ref(unwrap_value(expr.trim()));
    let name = read_ident_at(expr, 0)?;
    expr[name.len()..].trim().is_empty().then_some(name)
}
pub(crate) fn read_ident_at(source: &str, at: usize) -> Option<String> {
    let rest = source.get(at..)?;
    let name: String = rest.chars().take_while(|ch| is_ident_char(*ch)).collect();
    (!name.is_empty()).then_some(name)
}

fn is_single_eq(bytes: &[u8], index: usize) -> bool {
    bytes.get(index) == Some(&b'=')
        && !matches!(bytes.get(index + 1), Some(b'=' | b'>'))
        && !matches!(
            index.checked_sub(1).and_then(|prev| bytes.get(prev)),
            Some(b'=' | b'!' | b'<' | b'>')
        )
}

fn skip_type(bytes: &[u8], start: usize) -> usize {
    let mut depth = 0i32;
    let mut index = start;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'<' => depth += 1,
            b')' | b']' | b'>' if depth > 0 => depth -= 1,
            b',' | b')' | b'{' | b'=' | b'|' if depth == 0 => return index,
            b'-' if depth == 0 && bytes.get(index + 1) == Some(&b'>') => return index,
            _ => {}
        }
        index += 1;
    }
    index
}
