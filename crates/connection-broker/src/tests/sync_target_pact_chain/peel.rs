//! RHS wrappers around a dispatch alias: `()`, `{}`, `&`, `*`, block tails.
//!
//! Grouping parens unwrap. A tuple paren (a depth-0 comma inside) does not.
//! `stop_at_eq_paren` leaves the cursor inside a `(` that `=` introduces so
//! the tuple walker still sees that paren. A `{` unwraps only when the value
//! is the block tail, including after earlier statements in the block.
//! `unsafe`, `if` / `else`, `match`, and `loop { break … }` are part of that
//! tail. `;` and `{` inside strings, character literals, or comments are not
//! boundaries.

use super::super::sync_target_pact_norm::non_code_len;

/// Walk left from a value through RHS wrappers.
pub(super) fn peel_expr_prefix(
    bytes: &[u8],
    mut index: usize,
    stop_at_eq_paren: bool,
) -> Option<usize> {
    let code = code_mask(bytes);
    loop {
        index = skip_ws_back(bytes, index);
        if index == 0 {
            return Some(0);
        }
        let prev = index - 1;
        if !code[prev] {
            index = non_code_start(&code, prev);
            continue;
        }
        match bytes[prev] {
            b'&' | b'*' => index = prev,
            b'(' => {
                let eq_paren = stop_at_eq_paren && eq_before(bytes, prev).is_some();
                if !eq_paren && grouping_paren(bytes, &code, prev) {
                    index = prev;
                } else {
                    return Some(index);
                }
            }
            b'{' => match block_open(bytes, &code, index, prev) {
                Some(next) => index = next,
                None => return Some(index),
            },
            b'}' => {
                let Some(open) = matching_open_brace(bytes, &code, prev) else {
                    return Some(index);
                };
                index = open + 1;
            }
            b';' => match stmt_block(bytes, &code, index, prev) {
                Some(next) => index = next,
                None => return Some(index),
            },
            b'>' if arrow_at(bytes, prev) => {
                if let Some(open) = match_body_open(bytes, &code, prev - 1) {
                    index = open + 1;
                } else {
                    index = prev.saturating_sub(1);
                }
            }
            _ => match keyword_or_ref(bytes, index) {
                Some(at) => index = at,
                None => return Some(index),
            },
        }
    }
}

/// Single `=` before `index`, skipping whitespace. `==`, `!=`, `<=`, `>=`, `=>` are not it.
pub(super) fn eq_before(bytes: &[u8], index: usize) -> Option<usize> {
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
    if bytes.get(eq + 1) == Some(&b'>') {
        return None;
    }
    Some(eq)
}

fn skip_ws_back(bytes: &[u8], mut index: usize) -> usize {
    while index > 0 && bytes[index - 1].is_ascii_whitespace() {
        index -= 1;
    }
    index
}

pub(super) fn code_mask(bytes: &[u8]) -> Vec<bool> {
    let mut code = vec![true; bytes.len()];
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            let end = (index + len).min(bytes.len());
            for slot in &mut code[index..end] {
                *slot = false;
            }
            index = end.max(index + 1);
        } else {
            index += 1;
        }
    }
    code
}

fn non_code_start(code: &[bool], mut index: usize) -> usize {
    while index > 0 && !code[index - 1] {
        index -= 1;
    }
    index
}

fn keyword_or_ref(bytes: &[u8], index: usize) -> Option<usize> {
    ref_mut_cursor(bytes, index).or_else(|| break_cursor(bytes, index))
}

/// Cursor just after `&` when the value is `&mut place`, so the next peel sees `&`.
fn ref_mut_cursor(bytes: &[u8], index: usize) -> Option<usize> {
    let start = ident_end_back(bytes, index);
    if &bytes[start..index] != b"mut" {
        return None;
    }
    let at = skip_ws_back(bytes, start);
    (at > 0 && bytes[at - 1] == b'&').then_some(at)
}

fn break_cursor(bytes: &[u8], index: usize) -> Option<usize> {
    let at = skip_ws_back(bytes, index);
    let ident = ident_end_back(bytes, at);
    if ident < at && ident > 0 && bytes[ident - 1] == b'\'' {
        return keyword_ending(bytes, skip_ws_back(bytes, ident - 1), "break");
    }
    keyword_ending(bytes, at, "break")
}

fn keyword_ending(bytes: &[u8], at: usize, keyword: &str) -> Option<usize> {
    let raw = keyword.as_bytes();
    if at < raw.len() || &bytes[at - raw.len()..at] != raw {
        return None;
    }
    let start = at - raw.len();
    (start == 0 || !super::is_ident_byte(bytes[start - 1])).then_some(start)
}

fn ident_end_back(bytes: &[u8], mut end: usize) -> usize {
    while end > 0 && super::is_ident_byte(bytes[end - 1]) {
        end -= 1;
    }
    end
}

/// `(value)` is grouping. `(value,)` and `foo(value)` are not.
fn grouping_paren(bytes: &[u8], code: &[bool], open: usize) -> bool {
    if call_paren(bytes, open) {
        return false;
    }
    let mut depth = 0i32;
    let mut index = open;
    while index < bytes.len() {
        if !code[index] {
            index += 1;
            continue;
        }
        match bytes[index] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return true;
                }
            }
            // `::<A, B>` commas sit inside the group: tracking `<>` keeps a
            // turbofish comma from reading as the tuple comma of `(a, b)`.
            b'<' => depth += 1,
            b'>' if depth > 0 => depth -= 1,
            b',' if depth == 1 => return false,
            _ => {}
        }
        index += 1;
    }
    false
}

fn call_paren(bytes: &[u8], open: usize) -> bool {
    let at = skip_ws_back(bytes, open);
    at > 0 && (super::is_ident_byte(bytes[at - 1]) || matches!(bytes[at - 1], b'.' | b':' | b'>'))
}

fn block_open(bytes: &[u8], code: &[bool], index: usize, brace: usize) -> Option<usize> {
    block_tail(bytes, code, index).then(|| block_intro_start(bytes, code, brace))
}

fn stmt_block(bytes: &[u8], code: &[bool], index: usize, semicolon: usize) -> Option<usize> {
    let boundary = stmt_boundary(bytes, code, semicolon)?;
    (bytes.get(boundary) == Some(&b'{') && block_tail(bytes, code, index)).then_some(boundary)
}

/// True when `from` reaches `}` before a depth-0 `;`.
fn block_tail(bytes: &[u8], code: &[bool], from: usize) -> bool {
    let mut depth = 0i32;
    let mut index = from;
    while index < bytes.len() {
        if !code[index] {
            index += 1;
            continue;
        }
        match bytes[index] {
            b'{' | b'(' | b'[' => depth += 1,
            b'}' | b')' | b']' if depth > 0 => depth -= 1,
            b'}' => return true,
            b';' if depth == 0 => return false,
            _ => {}
        }
        index += 1;
    }
    false
}

fn block_intro_start(bytes: &[u8], code: &[bool], brace: usize) -> usize {
    immediate_keyword(bytes, brace, &["unsafe", "loop", "else"])
        .or_else(|| keyword_before_expr(bytes, code, brace))
        .unwrap_or(brace)
}

fn immediate_keyword(bytes: &[u8], brace: usize, keywords: &[&str]) -> Option<usize> {
    let at = skip_ws_back(bytes, brace);
    keywords
        .iter()
        .find_map(|keyword| keyword_ending(bytes, at, keyword))
}

fn keyword_before_expr(bytes: &[u8], code: &[bool], brace: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut index = brace;
    while index > 0 {
        index -= 1;
        if !code[index] {
            continue;
        }
        match bytes[index] {
            b')' | b']' => depth += 1,
            b'(' | b'[' if depth > 0 => depth -= 1,
            b';' | b'{' | b'}' if depth == 0 => return keyword_after(bytes, index + 1),
            b'=' if depth == 0 && stmt_eq(bytes, index) => return keyword_after(bytes, index + 1),
            _ => {}
        }
    }
    keyword_after(bytes, 0)
}

fn stmt_eq(bytes: &[u8], index: usize) -> bool {
    bytes.get(index) == Some(&b'=')
        && !matches!(bytes.get(index + 1), Some(b'=' | b'>'))
        && !matches!(
            index.checked_sub(1).and_then(|prev| bytes.get(prev)),
            Some(b'=' | b'!' | b'<' | b'>')
        )
}

fn keyword_after(bytes: &[u8], mut at: usize) -> Option<usize> {
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    ["if", "while", "match", "for", "loop"]
        .into_iter()
        .find(|keyword| keyword_at(bytes, at, keyword))
        .map(|_| at)
}

fn keyword_at(bytes: &[u8], at: usize, keyword: &str) -> bool {
    let raw = keyword.as_bytes();
    let end = at + raw.len();
    end <= bytes.len()
        && &bytes[at..end] == raw
        && bytes
            .get(end)
            .is_none_or(|byte| !super::is_ident_byte(*byte))
}

fn arrow_at(bytes: &[u8], gt: usize) -> bool {
    gt > 0 && bytes[gt] == b'>' && bytes[gt - 1] == b'='
}

fn match_body_open(bytes: &[u8], code: &[bool], eq: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut index = eq;
    while index > 0 {
        index -= 1;
        if !code[index] {
            continue;
        }
        match bytes[index] {
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' | b'{' if depth > 0 => depth -= 1,
            b'{' if depth == 0 => return Some(index),
            b';' if depth == 0 => return None,
            _ => {}
        }
    }
    None
}

fn matching_open_brace(bytes: &[u8], code: &[bool], close: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut index = close;
    loop {
        if code[index] {
            match bytes[index] {
                b'}' => depth += 1,
                b'{' if depth == 1 => return Some(index),
                b'{' => depth -= 1,
                _ => {}
            }
        }
        if index == 0 {
            return None;
        }
        index -= 1;
    }
}

fn stmt_boundary(bytes: &[u8], code: &[bool], semicolon: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut index = semicolon;
    while index > 0 {
        index -= 1;
        if !code[index] {
            continue;
        }
        match bytes[index] {
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' if depth > 0 => depth -= 1,
            b'{' | b';' if depth == 0 => return Some(index),
            b'{' => depth -= 1,
            _ => {}
        }
    }
    None
}

#[path = "peel_probes.rs"]
#[cfg(test)]
mod probes;
