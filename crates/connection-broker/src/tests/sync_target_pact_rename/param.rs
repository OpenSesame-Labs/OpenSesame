//! Typed parameters that shadow `let` bindings of the response receiver.
//!
//! `param_is_response` proves a name is a `Response`-typed parameter when no
//! `let` binds it. `param_shadows_let` decides whether such a parameter covers
//! the use of a same-named `let` binding that appeared earlier.
use super::super::sync_target_pact_norm::{is_keyword_at, string_len};
use super::bind::skip_type;
use super::marker::is_ident_char;
use super::peel::match_delim;

/// Whether the parameter covering the end of `prefix` is `Response`-typed.
/// The nearest covering parameter wins: an earlier sibling
/// `fn a(reply: Response)` must not type a later `fn b(reply: Status)` use
/// (Kimi council chunk06 P1).
pub(super) fn param_is_response(prefix: &str, name: &str) -> bool {
    param_shadows_let(prefix, name, 0).unwrap_or(false)
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
    super::peel::trailing_ident(strip_generics(ty.trim())).as_deref() == Some("Response")
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

fn skip_ws(bytes: &[u8], mut at: usize) -> usize {
    while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
        at += 1;
    }
    at
}

fn unwrap_parens(mut expr: &str) -> &str {
    while expr.starts_with('(') && expr.ends_with(')') && expr.len() >= 2 {
        expr = expr[1..expr.len() - 1].trim();
    }
    expr
}

/// A parameter of `name` after `after` whose body contains the end of `prefix`.
/// `Some(true)` when that param's type is `Response`. `Some(false)` when a
/// later param shadows the `let` with a different type. `None` when no such
/// param is in scope at the use.
pub(super) fn param_shadows_let(prefix: &str, name: &str, after: usize) -> Option<bool> {
    if name.is_empty() || after > prefix.len() {
        return None;
    }
    let bytes = prefix.as_bytes();
    let code = code_mask(bytes);
    let use_at = prefix.len();
    let mut index = after;
    let mut found = None;
    while index < use_at {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if is_keyword_at(bytes, index, name.as_bytes()) {
            if let Some(is_response) = covering_param(prefix, &code, name, index, use_at) {
                found = Some(is_response);
            }
            index += name.len();
            continue;
        }
        index += 1;
    }
    found
}

fn covering_param(
    prefix: &str,
    code: &[bool],
    name: &str,
    name_at: usize,
    use_at: usize,
) -> Option<bool> {
    if !param_slot(prefix, name_at) {
        return None;
    }
    let bytes = prefix.as_bytes();
    let at = skip_ws(bytes, name_at + name.len());
    let is_response = if bytes.get(at) == Some(&b':') && bytes.get(at + 1) != Some(&b':') {
        let end = skip_type(bytes, at + 1);
        type_is_response(&prefix[at + 1..end])
    } else if matches!(bytes.get(at), Some(b'|' | b',' | b')')) {
        false
    } else {
        return None;
    };
    let open = param_list_open(bytes, code, name_at)?;
    let covers = if bytes[open] == b'|' {
        closure_covers(prefix, open, name_at, use_at)
    } else {
        fn_covers(prefix, open, name_at, use_at)
    };
    covers.then_some(is_response)
}

fn code_mask(bytes: &[u8]) -> Vec<bool> {
    let mut code = vec![true; bytes.len()];
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            let end = (index + len).min(bytes.len());
            for slot in &mut code[index..end] {
                *slot = false;
            }
            index = end.max(index + 1);
            continue;
        }
        index += 1;
    }
    code
}

fn param_list_open(bytes: &[u8], code: &[bool], name_at: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut index = name_at;
    while index > 0 {
        index -= 1;
        if !code.get(index).copied().unwrap_or(false) {
            continue;
        }
        match bytes[index] {
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' if depth > 0 => depth -= 1,
            b'{' if depth > 0 => depth -= 1,
            b'{' | b';' if depth == 0 => return None,
            b'(' | b'|' if depth == 0 => return Some(index),
            _ => {}
        }
    }
    None
}

fn closure_covers(prefix: &str, pipe_open: usize, name_at: usize, use_at: usize) -> bool {
    let bytes = prefix.as_bytes();
    let Some(close) = matching_pipe(bytes, pipe_open) else {
        return false;
    };
    if close <= name_at || use_at <= close {
        return false;
    }
    let mut index = close + 1;
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    if bytes.get(index) == Some(&b'{') {
        return brace_covers(bytes, index, use_at);
    }
    braceless_covers(bytes, close + 1, use_at)
}

fn matching_pipe(bytes: &[u8], open: usize) -> Option<usize> {
    if bytes.get(open) != Some(&b'|') {
        return None;
    }
    let mut depth = 0i32;
    let mut index = open + 1;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' if depth > 0 => depth -= 1,
            b'|' if depth == 0 => return Some(index),
            _ => {}
        }
        index += 1;
    }
    None
}

fn fn_covers(prefix: &str, paren_open: usize, name_at: usize, use_at: usize) -> bool {
    let bytes = prefix.as_bytes();
    let Some(rel) = match_delim(&prefix[paren_open..], b'(', b')') else {
        return false;
    };
    let close = paren_open + rel;
    if name_at <= paren_open || name_at >= close {
        return false;
    }
    let Some(brace) = fn_body_open(bytes, close + 1) else {
        return false;
    };
    brace_covers(bytes, brace, use_at)
}

fn fn_body_open(bytes: &[u8], mut index: usize) -> Option<usize> {
    let mut depth = 0i32;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'<' => depth += 1,
            b')' | b']' | b'>' if depth > 0 => depth -= 1,
            b'{' if depth == 0 => return Some(index),
            b';' if depth == 0 => return None,
            _ => {}
        }
        index += 1;
    }
    None
}

fn brace_covers(bytes: &[u8], brace: usize, use_at: usize) -> bool {
    if use_at <= brace {
        return false;
    }
    let mut depth = 0i32;
    let mut index = brace;
    while index < use_at.min(bytes.len()) {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return false;
                }
            }
            _ => {}
        }
        index += 1;
    }
    depth > 0
}

fn braceless_covers(bytes: &[u8], body: usize, use_at: usize) -> bool {
    if use_at < body {
        return false;
    }
    let (mut depth, mut angle, mut index) = (0i32, 0i32, body);
    while index < use_at.min(bytes.len()) {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                if depth == 0 {
                    return false;
                }
                depth -= 1;
            }
            b'<' if depth == 0 && bytes.get(index + 1) != Some(&b'=') => angle += 1,
            b'>' if depth == 0 && angle > 0 && bytes.get(index + 1) != Some(&b'=') => {
                angle -= 1;
            }
            b',' | b';' if depth == 0 && angle == 0 => return false,
            _ => {}
        }
        index += 1;
    }
    true
}

#[cfg(test)]
mod probes {
    use crate::tests::sync_target_pact_scan::response_body_reads;

    fn reads(sample: &str) -> bool {
        !response_body_reads(sample).is_empty()
    }

    #[test]
    fn council_r3_later_param_shadows_let() {
        let hits = [
            "let reply = status; |reply: Response| reply.into()",
            "let reply = status; |mut reply: Response| reply.into()",
            "let reply = status; fn steal(reply: Response) { reply.into() }",
            "let reply = status; fn steal(mut reply: reqwest::Response) { reply.into() }",
            "let reply = status; fn steal(reply: http::Response<Body>) { reply.into() }",
            "let reply = response; |x| reply.into()",
            "let reply = response; reply.into()",
        ];
        for sample in hits {
            assert!(
                reads(sample),
                "param or live binding must stay a body read: {sample}"
            );
        }
        let misses = [
            "fn steal(reply: Response) { let reply = status; reply.into() }",
            "let reply = status; |reply: Response| { let _ = reply; }; reply.into()",
            "let reply = status; fn steal(reply: Response) { let _ = reply; } reply.into()",
            "let reply = response; |reply: Status| reply.into()",
            "let reply = response; fn steal(reply: Status) { reply.into() }",
            "let reply = status; |reply| reply.into()",
            "let reply = status; reply.into()",
        ];
        for sample in misses {
            assert!(
                !reads(sample),
                "shadowed or unrelated reply is not a body read: {sample}"
            );
        }
    }

    /// With no local binding, the nearest covering parameter types the use —
    /// not the first same-named parameter in the prefix. An earlier sibling
    /// `fn a(reply: Response)` must not make `fn b(reply: Status)` look
    /// response-typed, and a later `Response` param must still win over an
    /// earlier `Status` one (Kimi council chunk06 P1).
    #[test]
    fn kimi_council_r3_param_resolves_nearest_covering_fn_param() {
        let hits = [
            "fn a(reply: Status) { let _ = reply; } fn b(reply: Response) { reply.into() }",
            "fn a(reply: Response) { let _ = reply; } fn b(reply: Response) { reply.into() }",
        ];
        for sample in hits {
            assert!(
                reads(sample),
                "nearest covering param is the Response one: {sample}"
            );
        }
        let misses = [
            "fn a(reply: Response) { let _ = reply; } fn b(reply: Status) { reply.into() }",
            "fn a(reply: Response) { let _ = reply; } fn b() { reply.into() }",
        ];
        for sample in misses {
            assert!(
                !reads(sample),
                "an earlier sibling param must not type this use: {sample}"
            );
        }
    }
}
