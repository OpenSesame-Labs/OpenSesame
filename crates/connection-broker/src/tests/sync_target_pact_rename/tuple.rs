//! Tuple patterns that bind a response receiver to one tuple element.
use super::super::sync_target_pact_norm::string_len;
use super::bind::{is_single_eq, read_ident_at, rhs_ident, skip_type, skip_ws};
use super::marker::is_ident_char;
use super::peel::match_delim;

pub(super) fn let_tuple_named_rhs(
    prefix: &str,
    bytes: &[u8],
    pat_open: usize,
    name: &str,
) -> Option<(String, usize)> {
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
    let rhs_raw = prefix.get(rhs_at..)?;
    let lead = rhs_raw.len() - rhs_raw.trim_start().len();
    let rhs = &rhs_raw[lead..];
    let base = rhs_at + lead;
    if let Some(inside) = unwrap_tuple_rhs(rhs) {
        if let Some(path) = tuple_bind_path(pattern, name) {
            return tuple_piece_ident(rhs, base, inside, &path);
        }
    }
    rhs_ident(prefix, rhs_at)
}

fn tuple_piece_ident(
    rhs: &str,
    base: usize,
    inside: &str,
    path: &[usize],
) -> Option<(String, usize)> {
    let piece = descend_tuple_rhs(inside, path);
    // A missed path returns a static `""`, which is not a subslice of `rhs`.
    // A real element keeps its leading ident, same as `let reply = response.clone()`.
    if piece.is_empty() {
        return None;
    }
    let rel = slice_offset(rhs, piece);
    let (name, at) = rhs_ident(piece, 0)?;
    Some((name, base + rel + at))
}

/// The RHS tuple interior. Peel one `(...)` only: `unwrap_value` also drops a
/// paren when `;` follows, which shortens `((response,),)` before the path walk.
fn unwrap_tuple_rhs(rhs: &str) -> Option<&str> {
    let rhs = super::peel::strip_ref(rhs.trim());
    let close = match_delim(rhs, b'(', b')')?;
    Some(rhs[1..close].trim())
}

fn tuple_bind_path(pattern: &str, name: &str) -> Option<Vec<usize>> {
    let inside = wrapped_tuple(pattern.trim()).unwrap_or(pattern.trim());
    for (index, part) in tuple_split(inside).into_iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if direct_tuple_bind(part, name) {
            return Some(vec![index]);
        }
        let Some(inner) = wrapped_tuple(strip_binding_mods(part.trim())) else {
            continue;
        };
        if let Some(mut path) = tuple_bind_path(inner, name) {
            path.insert(0, index);
            return Some(path);
        }
    }
    None
}

/// `inside` is already the tuple interior. Each path index selects an element;
/// a nested index unwraps that element first.
fn descend_tuple_rhs<'a>(inside: &'a str, path: &[usize]) -> &'a str {
    let mut piece = inside.trim();
    for (step, &index) in path.iter().enumerate() {
        let Some(next) = tuple_split(piece).get(index).copied() else {
            return "";
        };
        piece = next.trim();
        if step + 1 == path.len() {
            break;
        }
        let Some(inner) = wrapped_tuple(piece) else {
            return "";
        };
        piece = inner.trim();
    }
    piece
}

fn wrapped_tuple(expr: &str) -> Option<&str> {
    let expr = expr.trim();
    let close = match_delim(expr, b'(', b')')?;
    expr[close + 1..]
        .trim()
        .is_empty()
        .then(|| expr[1..close].trim())
}

pub(super) fn tuple_split(inside: &str) -> Vec<&str> {
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

pub(super) fn tuple_pattern_binds(elem: &str, name: &str) -> bool {
    direct_tuple_bind(elem, name) || tuple_bind_path(elem, name).is_some()
}

/// `(reply,)` and `((reply,),)` bind `reply`. A trailing comma is not part of the name.
fn direct_tuple_bind(part: &str, name: &str) -> bool {
    let part = strip_binding_mods(part.trim());
    if part.is_empty() || part.starts_with('(') {
        return false;
    }
    let Some(ident) = read_ident_at(part, 0) else {
        return false;
    };
    if ident != name {
        return false;
    }
    let rest = part[ident.len()..].trim_start();
    rest.is_empty() || rest.starts_with(':')
}

fn strip_binding_mods(mut elem: &str) -> &str {
    loop {
        let trimmed = elem.trim_start();
        if let Some(rest) = strip_one_mod(trimmed, "ref") {
            elem = rest;
            continue;
        }
        if let Some(rest) = strip_one_mod(trimmed, "mut") {
            elem = rest;
            continue;
        }
        return trimmed;
    }
}

fn strip_one_mod<'a>(elem: &'a str, keyword: &str) -> Option<&'a str> {
    let rest = elem.strip_prefix(keyword)?;
    if rest.chars().next().is_some_and(is_ident_char) {
        return None;
    }
    Some(rest.trim_start())
}

fn slice_offset(outer: &str, inner: &str) -> usize {
    inner.as_ptr() as usize - outer.as_ptr() as usize
}

#[cfg(test)]
mod probes {
    use crate::tests::sync_target_pact_scan::response_body_reads;

    fn reads(sample: &str) -> bool {
        !response_body_reads(sample).is_empty()
    }

    #[test]
    fn council_p1_tuple_clone_keeps_leading_ident() {
        let hits = [
            "let (reply,) = (response.clone(),); reply.into()",
            "let (reply,) = (response.by_ref(),); reply.into()",
            "let ((reply,),) = ((response.clone(),),); reply.into()",
            "let (mut reply,) = (response.clone(),); reply.into()",
            "let reply = response.clone(); reply.into()",
        ];
        for sample in hits {
            assert!(
                reads(sample),
                "tuple element keeps the leading ident: {sample}"
            );
        }
        let misses = [
            "let (reply,) = (status.clone(),); reply.into()",
            "let (reply,) = (status,); reply.into()",
        ];
        for sample in misses {
            assert!(
                !reads(sample),
                "unrelated tuple element is not a body read: {sample}"
            );
        }
    }
}
