//! RHS wrappers around a dispatch alias: `()`, `{}`, `&`, `*`, block tails.
//!
//! Grouping parens unwrap. A tuple paren (a depth-0 comma inside) does not.
//! `stop_at_eq_paren` leaves the cursor inside a `(` that `=` introduces so
//! the tuple walker still sees that paren. A `{` unwraps only when the value
//! is the block tail, including after earlier statements in the block.

/// Walk left from a value through RHS wrappers.
pub(super) fn peel_expr_prefix(
    bytes: &[u8],
    mut index: usize,
    stop_at_eq_paren: bool,
) -> Option<usize> {
    loop {
        index = skip_ws_back(bytes, index);
        if index == 0 {
            return Some(0);
        }
        let prev = index - 1;
        match bytes[prev] {
            b'&' | b'*' => index = prev,
            b'(' => {
                let eq_paren = stop_at_eq_paren && eq_before(bytes, prev).is_some();
                if !eq_paren && grouping_paren(bytes, prev) {
                    index = prev;
                } else {
                    return Some(index);
                }
            }
            b'{' => {
                if block_tail(bytes, index) {
                    index = prev;
                } else {
                    return Some(index);
                }
            }
            b';' => {
                let Some(boundary) = stmt_boundary(bytes, prev) else {
                    return Some(index);
                };
                if bytes.get(boundary) != Some(&b'{') || !block_tail(bytes, index) {
                    return Some(index);
                }
                index = boundary;
            }
            _ => match ref_mut_cursor(bytes, index) {
                Some(at) => index = at,
                None => return Some(index),
            },
        }
    }
}

/// Single `=` before `index`, skipping whitespace. `==`, `!=`, `<=`, `>=` are not it.
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
    Some(eq)
}

fn skip_ws_back(bytes: &[u8], mut index: usize) -> usize {
    while index > 0 && bytes[index - 1].is_ascii_whitespace() {
        index -= 1;
    }
    index
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

fn ident_end_back(bytes: &[u8], mut end: usize) -> usize {
    while end > 0 && super::is_ident_byte(bytes[end - 1]) {
        end -= 1;
    }
    end
}

/// `(value)` is grouping. `(value,)` and `foo(value)` are not.
fn grouping_paren(bytes: &[u8], open: usize) -> bool {
    if call_paren(bytes, open) {
        return false;
    }
    let mut depth = 0i32;
    let mut index = open;
    while index < bytes.len() {
        match bytes[index] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return true;
                }
            }
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

/// True when `from` reaches `}` before a depth-0 `;`.
fn block_tail(bytes: &[u8], from: usize) -> bool {
    let mut depth = 0i32;
    let mut index = from;
    while index < bytes.len() {
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

fn stmt_boundary(bytes: &[u8], semicolon: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut index = semicolon;
    while index > 0 {
        index -= 1;
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
