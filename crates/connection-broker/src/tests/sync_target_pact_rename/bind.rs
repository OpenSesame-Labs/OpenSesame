//! `let`/`=` bindings and tuple patterns.
use super::super::sync_target_pact_norm::{is_keyword_at, string_len};
use super::marker::{find_marker, is_ident_byte, is_ident_char};
use super::peel::{match_delim, strip_ref, trailing_ident, unwrap_parens, unwrap_value};

struct BindHit {
    depth: i32,
    name: String,
    at: usize,
}

/// Visible binding of `name` and the source position of its RHS ident.
/// A `let` inside a finished block does not stay visible. The position lets
/// the next hop ignore a later shadow of that RHS.
pub(super) fn let_bind_rhs(prefix: &str, name: &str) -> Option<(String, usize)> {
    let bytes = prefix.as_bytes();
    let mut index = 0usize;
    let mut depth = 0i32;
    let mut stack: Vec<BindHit> = Vec::new();
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' => {
                depth += 1;
                index += 1;
                continue;
            }
            b'}' => {
                if depth > 0 {
                    depth -= 1;
                }
                while stack.last().is_some_and(|hit| hit.depth > depth) {
                    stack.pop();
                }
                index += 1;
                continue;
            }
            _ => {}
        }
        if let Some(hit) = binding_hit(prefix, bytes, index, name) {
            push_hit(&mut stack, depth, hit);
        }
        index += 1;
    }
    stack.last().map(|hit| (hit.name.clone(), hit.at))
}

struct FoundBind {
    is_let: bool,
    name: String,
    at: usize,
}

fn binding_hit(prefix: &str, bytes: &[u8], index: usize, name: &str) -> Option<FoundBind> {
    if is_keyword_at(bytes, index, b"let") {
        let (bound, at) = let_named_rhs(prefix, bytes, index, name)?;
        return Some(FoundBind {
            is_let: true,
            name: bound,
            at,
        });
    }
    if is_keyword_at(bytes, index, name.as_bytes()) && !field_place(bytes, index) {
        let (bound, at) = assign_rhs(prefix, bytes, index + name.len())?;
        return Some(FoundBind {
            is_let: false,
            name: bound,
            at,
        });
    }
    None
}

/// `self.reply = status` and `Type::reply = status` are not local rebinds.
fn field_place(bytes: &[u8], index: usize) -> bool {
    let mut at = index;
    while at > 0 && bytes[at - 1].is_ascii_whitespace() {
        at -= 1;
    }
    if at > 0 && bytes[at - 1] == b'.' {
        return true;
    }
    at >= 2 && bytes[at - 1] == b':' && bytes[at - 2] == b':'
}

fn push_hit(stack: &mut Vec<BindHit>, depth: i32, hit: FoundBind) {
    if !hit.is_let {
        if let Some(top) = stack.last_mut() {
            top.name = hit.name;
            top.at = hit.at;
            return;
        }
    } else if stack.last().is_some_and(|top| top.depth == depth) {
        stack.pop();
    }
    stack.push(BindHit {
        depth,
        name: hit.name,
        at: hit.at,
    });
}

fn let_named_rhs(prefix: &str, bytes: &[u8], index: usize, name: &str) -> Option<(String, usize)> {
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

fn assign_rhs(prefix: &str, bytes: &[u8], at: usize) -> Option<(String, usize)> {
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

fn rhs_ident(source: &str, at: usize) -> Option<(String, usize)> {
    let raw = source.get(at..)?;
    let lead = raw.len() - raw.trim_start().len();
    let trimmed = &raw[lead..];
    let expr = strip_ref(unwrap_value(trimmed));
    let expr_at = at + lead + slice_offset(trimmed, expr);
    if matches!(read_ident_at(expr, 0).as_deref(), Some("if" | "match")) {
        if let Some(found) = branch_response(source, expr, expr_at) {
            return Some(found);
        }
    }
    if credentialed_send_expr(expr) {
        return Some(("response".to_string(), expr_at));
    }
    let name = read_ident_at(expr, 0)?;
    Some((name, expr_at))
}

fn slice_offset(outer: &str, inner: &str) -> usize {
    inner.as_ptr() as usize - outer.as_ptr() as usize
}

/// An `if` / `match` initializer aliases the response when any branch value does.
fn branch_response(source: &str, expr: &str, expr_at: usize) -> Option<(String, usize)> {
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
            return Some((name.to_string(), expr_at + start));
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

fn let_tuple_named_rhs(
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
    let rhs = strip_ref(rhs.trim());
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

    #[test]
    fn council_r3_field_assign_does_not_rebind_local() {
        let hits = [
            "let reply = response; self.reply = status; reply.into()",
            "let reply = response; self . reply = status; reply.into()",
            "let reply = response; Type::reply = status; reply.into()",
            "let mut reply = other; reply = response; reply.into()",
        ];
        for sample in hits {
            assert!(reads(sample), "local reply stays the response: {sample}");
        }
        let misses = [
            "let reply = status; self.reply = response; reply.into()",
            "let reply = status; obj.reply = response; reply.into()",
            "let reply = status; Type::reply = response; reply.into()",
        ];
        for sample in misses {
            assert!(
                !reads(sample),
                "field assign must not rebind the local: {sample}"
            );
        }
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
}
