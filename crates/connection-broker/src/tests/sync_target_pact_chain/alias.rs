//! Dispatch aliases: function items, reassignment, blocks, and calls.
use super::super::sync_target_pact_norm::{function_spans, non_code_len, string_len};

#[path = "alias_shadow.rs"]
mod shadow;

/// `(call_index, ident_len)` for `let name = Path::{send,execute}` function items.
/// The binding is not a dispatch; only a later `name(…)` in that function is.
/// `()`, `{}`, `&`, `*`, and a block tail (`{ stmts; value }`) still create the
/// alias, including `dispatch = Path::send` with no `let`. `let call = name`,
/// `call = name`, `let call = &name`, and `let call = { stmts; name }` forward it.
/// `let (name,) = ((Path::send),)` does too.
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
    let name = let_name_before_path(source, index)
        .or_else(|| super::tuple::tuple_binding_name(source, index))?;
    Some((name, head_len))
}

/// `let call = dispatch`, `call = dispatch`, and `let call = { dispatch }`
/// when `dispatch` is already a send alias in this function.
fn alias_forward_let(
    source: &str,
    aliases: &[DispatchAlias],
    spans: &[(usize, usize)],
    index: usize,
) -> Option<(String, usize)> {
    let bytes = source.as_bytes();
    if index > 0 {
        let prev = bytes[index - 1];
        if super::is_ident_byte(prev) || prev == b'.' || prev == b':' {
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
            .is_none_or(|ch| !super::is_ident_char(ch));
    if !terminator && !cast {
        return None;
    }
    let eq = value_eq(bytes, index)?;
    let (fn_start, _) = innermost_span(spans, index)?;
    let known = aliases
        .iter()
        .any(|alias| alias.fn_start == fn_start && alias.at < index && alias.name == name);
    if !known {
        return None;
    }
    let new_name = assign_target(source[..eq].trim_end())?;
    (new_name != name).then_some((new_name, name.len()))
}

/// `=` before this value. `()`, `{}`, `&`, `*`, and `{ stmts; value }` unwrap.
fn value_eq(bytes: &[u8], index: usize) -> Option<usize> {
    super::peel::eq_before(bytes, super::peel::peel_expr_prefix(bytes, index, false)?)
}

/// Left-hand side of `let call = …` or `call = …`.
fn assign_target(lhs: &str) -> Option<String> {
    if let Some(name) = super::super::sync_target_pact_let::let_binding_name(lhs) {
        return Some(name);
    }
    let tail = statement_tail(lhs);
    let name = super::trailing_ident(tail);
    if name.is_empty() || name == "_" {
        return None;
    }
    let mut before = tail[..tail.len() - name.len()].trim_end();
    if super::tuple::ends_with_kw(before, "mut") {
        before = before[..before.len() - "mut".len()].trim_end();
    }
    before.is_empty().then_some(name)
}

pub(super) fn statement_tail(lhs: &str) -> &str {
    let bytes = lhs.as_bytes();
    let code = super::peel::code_mask(bytes);
    let mut depth = 0i32;
    let mut index = bytes.len();
    while index > 0 {
        index -= 1;
        if !code[index] {
            continue;
        }
        match bytes[index] {
            // `->` is not a generic closer.
            b'>' if index > 0 && bytes[index - 1] == b'-' && code[index - 1] => {}
            // A finished block ends the statement. Entering it would let a `;`
            // inside `if` / `loop` become the tail, so `dispatch = Path::send`
            // no longer parses as a bare name.
            b'}' if depth == 0 => return trim_noise_ends(&lhs[index + 1..]),
            b')' | b']' | b'>' | b'}' => depth += 1,
            b'(' | b'[' | b'<' | b'{' if depth > 0 => depth -= 1,
            b';' | b'{' if depth == 0 => return trim_noise_ends(&lhs[index + 1..]),
            _ => {}
        }
    }
    trim_noise_ends(lhs)
}

/// Whitespace and comments against either end are not part of the tail.
fn trim_noise_ends(tail: &str) -> &str {
    let bytes = tail.as_bytes();
    let code = super::peel::code_mask(bytes);
    let mut start = 0usize;
    let mut end = bytes.len();
    while start < end && (bytes[start].is_ascii_whitespace() || !code[start]) {
        start += 1;
    }
    while end > start && (bytes[end - 1].is_ascii_whitespace() || !code[end - 1]) {
        end -= 1;
    }
    &tail[start..end]
}

/// Whitespace and comments between a name and the next code byte: after a
/// function item's terminator or before an alias call's argument list.
fn skip_item_gap(after: &str) -> &str {
    let bytes = after.as_bytes();
    let mut index = 0usize;
    loop {
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if index == start {
            return &after[index..];
        }
    }
}

fn function_item_head(source: &str, index: usize) -> Option<usize> {
    let rest = &source[index..];
    const HEADS: &[&str] = &["::execute", "::send", ".execute", ".send"];
    let head = HEADS.iter().copied().find(|head| rest.starts_with(head))?;
    if head.starts_with('.') && index > 0 && source.as_bytes()[index - 1] == b':' {
        return None;
    }
    let after = &rest[head.len()..];
    if after.chars().next().is_some_and(super::is_ident_char) {
        return None;
    }
    let after = skip_item_gap(strip_turbofish(after).unwrap_or(after));
    if after.starts_with('(') {
        return None;
    }
    let next = after.chars().next();
    let terminator = matches!(next, Some(';' | ')' | ',' | ']' | '}') | None);
    let cast = after.starts_with("as")
        && after[2..]
            .chars()
            .next()
            .is_none_or(|ch| !super::is_ident_char(ch));
    (terminator || cast).then_some(head.len())
}

fn let_name_before_path(source: &str, head: usize) -> Option<String> {
    let path_start = path_prefix_start(source, head);
    if let Some(eq) = value_eq(source.as_bytes(), path_start) {
        // `let name =`, `let name: Type =`, and `name =` (no `let`).
        return assign_target(source[..eq].trim_end());
    }
    super::super::sync_target_pact_let::typed_let_name_before_path(source, head)
}

pub(super) fn path_prefix_start(source: &str, head: usize) -> usize {
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
            // `=>` ends a match arm. It is not a generic closer (`Vec<T>::send`).
            let gt = index - ch.len_utf8();
            if gt > 0 && source.as_bytes()[gt - 1] == b'=' {
                break;
            }
            angle = 1;
            index -= ch.len_utf8();
            continue;
        }
        if super::is_ident_char(ch) || ch == ':' {
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
        if super::is_ident_byte(prev) || prev == b'.' || prev == b':' {
            return None;
        }
    }
    let name = leading_ident(&source[index..]);
    if name.is_empty() {
        return None;
    }
    // Whitespace and comments before the argument list are not a boundary:
    // `dispatch (request)` and `dispatch /* c */ (request)` are calls.
    let mut after = skip_item_gap(&source[index + name.len()..]);
    after = strip_turbofish(after).map(skip_item_gap).unwrap_or(after);
    while after.starts_with(')') {
        after = skip_item_gap(&after[1..]);
        after = strip_turbofish(after).map(skip_item_gap).unwrap_or(after);
    }
    if !after.starts_with('(') {
        return None;
    }
    let (fn_start, _) = innermost_span(spans, index)?;
    aliases
        .iter()
        .any(|alias| {
            alias.fn_start == fn_start
                && alias.at < index
                && alias.name == name
                && !shadow::alias_shadowed(source, alias, index)
        })
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
    source
        .chars()
        .take_while(|ch| super::is_ident_char(*ch))
        .collect()
}

#[cfg(test)]
mod shadow_probes {
    use super::dispatch_alias_calls;

    #[test]
    fn dispatch_assign_rebind_shadows_call() {
        let rebound =
            "fn f() { let dispatch = Path::send; dispatch = other_fn; dispatch(request); }";
        assert!(
            dispatch_alias_calls(rebound).is_empty(),
            "assign rebind must hide the alias call: {rebound}"
        );
        let live = "fn f() { let dispatch = Path::send; dispatch(request); }";
        assert_eq!(
            dispatch_alias_calls(live).len(),
            1,
            "establishing let must not shadow its own call: {live}"
        );
        let comment = "fn f() { let dispatch = Path::send; // let (\n dispatch(request); }";
        assert_eq!(
            dispatch_alias_calls(comment).len(),
            1,
            "a comment must not fake a shadowing let: {comment}"
        );
        let tuple = "fn f() { let dispatch = Path::send; let (n,) = (1,); dispatch(request); }";
        assert_eq!(
            dispatch_alias_calls(tuple).len(),
            1,
            "an unrelated tuple let must not shadow: {tuple}"
        );
    }
}
