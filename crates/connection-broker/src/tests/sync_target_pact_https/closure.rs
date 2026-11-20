//! Closure-local `return` does not satisfy the HTTPS guard.
use super::super::sync_target_pact_norm::string_len;
use super::is_ident_char;

pub(super) fn closure_owns(before: &str) -> bool {
    let bytes = before.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes[index] == b'|'
            && pipe_is_closure(before, index)
            && closure_body_at(before, index).is_some_and(|at| runs_to_end(&before[at..]))
        {
            return true;
        }
        index += 1;
    }
    false
}

fn pipe_is_closure(body: &str, pipe: usize) -> bool {
    if pipe == 0 {
        return true;
    }
    let prev = body.as_bytes()[pipe - 1];
    matches!(prev, b'=' | b'(' | b'{' | b',' | b';' | b'[')
        || matches!(trailing_name(&body[..pipe]), "move" | "async")
}

fn closure_body_at(body: &str, pipe: usize) -> Option<usize> {
    let bytes = body.as_bytes();
    if bytes.get(pipe + 1) == Some(&b'|') {
        return Some(pipe + 2);
    }
    let (mut depth, mut index) = (0i32, pipe + 1);
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' if depth > 0 => depth -= 1,
            b'|' if depth == 0 => return Some(index + 1),
            b';' | b'=' if depth == 0 => return None,
            _ => {}
        }
        index += 1;
    }
    None
}

fn runs_to_end(body: &str) -> bool {
    let bytes = body.as_bytes();
    let (mut depth, mut index) = (0i32, 0usize);
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' => {
                if depth == 0 {
                    return false;
                }
                depth -= 1;
            }
            b',' | b';' if depth == 0 => return false,
            _ => {}
        }
        index += 1;
    }
    true
}

pub(super) fn trailing_name(prefix: &str) -> &str {
    let mut start = prefix.len();
    for (index, ch) in prefix.char_indices().rev() {
        if !is_ident_char(ch) {
            break;
        }
        start = index;
    }
    &prefix[start..]
}
