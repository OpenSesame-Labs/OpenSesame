//! Scheme predicate, closure-local `return`, and URL binding for the HTTPS guard.
use super::super::sync_target_pact_norm::{is_keyword_at, match_brace, string_len};
use super::{after_paren, ident_at, strip_turbofish};

#[path = "guard_parse.rs"]
mod guard_parse;

use guard_parse::{last_rhs, url_parse_arg};

pub(super) fn guarded(prefix: &str, dest: Option<&str>) -> bool {
    let bytes = prefix.as_bytes();
    // `prefix` starts at the function's `{`, so statements in the body sit at
    // depth 1. A scheme `if` nested in another block does not dominate a send
    // that follows the outer block (`if ready { if url.scheme() … { return } }`).
    let mut index = 0usize;
    let mut depth = 0i32;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            _ => {}
        }
        if depth == 1
            && is_keyword_at(bytes, index, b"if")
            && !preceded_by_else(bytes, index)
            && if_guard(prefix, index, dest)
        {
            return true;
        }
        index += 1;
    }
    false
}

/// `else if` is still conditional: the send after the chain runs when `else` is skipped.
fn preceded_by_else(bytes: &[u8], index: usize) -> bool {
    let mut at = index;
    while at > 0 && bytes[at - 1].is_ascii_whitespace() {
        at -= 1;
    }
    at >= 4 && is_keyword_at(bytes, at - 4, b"else")
}

fn if_guard(prefix: &str, if_at: usize, dest: Option<&str>) -> bool {
    let bytes = prefix.as_bytes();
    let Some(open) = condition_brace(bytes, if_at + 2) else {
        return false;
    };
    let cond = prefix[if_at + 2..open].trim();
    let closed = match dest {
        Some(dest) => covers_dest(cond, false, &prefix[..if_at], dest),
        None => fails_closed(cond, false),
    };
    if !closed {
        return false;
    }
    let Some(close) = match_brace(bytes, open) else {
        return false;
    };
    if !depth0_return(&prefix[open + 1..close]) {
        return false;
    }
    if dest.is_some_and(|name| !name.is_empty() && super::bind::shadows(&prefix[close + 1..], name))
    {
        return false;
    }
    true
}

fn covers_dest(expr: &str, negated: bool, before: &str, dest: &str) -> bool {
    eval_guard(expr, negated, &mut |leaf| scheme_covers(leaf, before, dest))
}

fn fails_closed(expr: &str, negated: bool) -> bool {
    // `||` / `&&` bind looser than unary `!`, so `eval_guard` splits them first.
    eval_guard(expr, negated, &mut whole_scheme_neq)
}

fn eval_guard(expr: &str, negated: bool, leaf: &mut dyn FnMut(&str) -> bool) -> bool {
    let expr = peel(expr);
    if let Some((left, right)) = split_top(expr, "||") {
        let lhs = eval_guard(left, negated, leaf);
        let rhs = eval_guard(right, negated, leaf);
        return if negated { lhs && rhs } else { lhs || rhs };
    }
    if let Some((left, right)) = split_top(expr, "&&") {
        let lhs = eval_guard(left, negated, leaf);
        let rhs = eval_guard(right, negated, leaf);
        return if negated { lhs || rhs } else { lhs && rhs };
    }
    if expr.starts_with('!') && !expr.starts_with("!=") {
        return eval_guard(peel(&expr[1..]), !negated, leaf);
    }
    !negated && leaf(expr)
}

fn scheme_covers(expr: &str, before: &str, dest: &str) -> bool {
    let expr = expr.trim();
    let Some(subject) = scheme_subject(expr) else {
        return false;
    };
    if subject == dest {
        return true;
    }
    let Some((rhs, end)) = last_rhs(before, &subject) else {
        return false;
    };
    // `url = evil` between `Url::parse(url)` and this guard checks a stale
    // copy. A mutation of the parsed subject is just as stale:
    // `parsed.set_scheme("https")` after `Url::parse(&url)` checks a value the
    // sent `url` no longer has.
    url_parse_arg(rhs) == Some(dest)
        && !super::bind::shadows(&before[end..], dest)
        && !super::bind::shadows(&before[end..], &subject)
}

fn scheme_subject(expr: &str) -> Option<String> {
    let at = scheme_at(expr)?;
    let bytes = expr.as_bytes();
    if at > 0 && bytes[at - 1] == b'.' {
        // `config.url.scheme()` is not a guard for the plain binding `url`.
        return plain_scheme_receiver(&expr[..at - 1]);
    }
    if at >= 2 && &bytes[at - 2..at] == b"::" {
        let mut rest = &expr[at + "scheme".len()..];
        if let Some(stripped) = strip_turbofish(rest) {
            rest = stripped;
        }
        let arg = strip_ref(first_arg(args_of(rest)?));
        return plain_ident(arg).map(str::to_string);
    }
    None
}

fn plain_scheme_receiver(recv: &str) -> Option<String> {
    let mut recv = recv.trim();
    while let Some(inner) = paren_wrap(recv) {
        recv = inner.trim();
    }
    super::bind::plain_ident(peel_ref(recv)).map(str::to_string)
}

fn paren_wrap(expr: &str) -> Option<&str> {
    let expr = expr.trim();
    let rest = expr.strip_prefix('(')?;
    let after = super::after_paren(rest)?;
    if !after.trim().is_empty() {
        return None;
    }
    Some(rest[..rest.len() - after.len() - 1].trim())
}

fn peel_ref(mut recv: &str) -> &str {
    loop {
        if let Some(rest) = recv.strip_prefix("&mut") {
            if rest
                .chars()
                .next()
                .is_none_or(|ch| !super::is_ident_char(ch))
            {
                recv = rest.trim_start();
                continue;
            }
        }
        if let Some(rest) = recv.strip_prefix('&') {
            recv = rest.trim_start();
            continue;
        }
        return recv;
    }
}

fn scheme_at(expr: &str) -> Option<usize> {
    let bytes = expr.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if let Some(end) = scheme_neq_end(expr, index) {
            let prefix = &expr[..index];
            if end == expr.len() && !prefix.bytes().any(|b| matches!(b, b'!' | b'&' | b'|')) {
                return Some(index);
            }
            return None;
        }
        index += 1;
    }
    None
}

fn whole_scheme_neq(expr: &str) -> bool {
    scheme_at(expr.trim()).is_some()
}

fn peel(expr: &str) -> &str {
    if let Some(rest) = expr.strip_prefix('(') {
        if let Some(after) = after_paren(rest) {
            if after.is_empty() {
                return peel(&expr[1..expr.len() - 1]);
            }
        }
    }
    expr
}

fn split_top<'a>(expr: &'a str, op: &str) -> Option<(&'a str, &'a str)> {
    let bytes = expr.as_bytes();
    let mut index = 0usize;
    let mut depth = 0i32;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        depth += match bytes[index] {
            b'(' | b'[' | b'{' => 1,
            b')' | b']' | b'}' => -1,
            _ => 0,
        };
        if depth == 0 && expr[index..].starts_with(op) {
            return Some((&expr[..index], &expr[index + op.len()..]));
        }
        index += 1;
    }
    None
}

fn condition_brace(bytes: &[u8], from: usize) -> Option<usize> {
    let mut paren = 0i32;
    let mut index = from;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' => paren += 1,
            b')' => paren -= 1,
            b'{' if paren == 0 => return Some(index),
            b';' if paren == 0 => return None,
            _ => {}
        }
        index += 1;
    }
    None
}

fn depth0_return(body: &str) -> bool {
    let bytes = body.as_bytes();
    // Paren and bracket depth count, not only braces: a `return` token inside
    // a macro invocation's token tree (`swallow!(return Err("x"));`) is an
    // argument the macro may never emit, so it cannot fail-close the branch.
    let (mut depth, mut index, mut stmt) = (0i32, 0usize, 0usize);
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' | b'(' | b'[' => depth += 1,
            b'}' | b')' | b']' => depth -= 1,
            b';' if depth == 0 => stmt = index + 1,
            _ if depth == 0 && is_keyword_at(bytes, index, b"return") => {
                if !super::closure::closure_owns(&body[stmt..index]) {
                    return true;
                }
            }
            _ => {}
        }
        index += 1;
    }
    false
}

fn scheme_neq_end(source: &str, index: usize) -> Option<usize> {
    if !ident_at(source.as_bytes(), index, b"scheme") {
        return None;
    }
    let mut rest = &source[index + "scheme".len()..];
    if let Some(stripped) = strip_turbofish(rest) {
        rest = stripped;
    }
    rest = rest.strip_prefix('(')?;
    rest = after_paren(rest)?;
    let trimmed = rest.trim_start_matches(')');
    let extra = rest.len() - trimmed.len();
    let consumed = https_cmp_len(trimmed)?;
    Some(source.len() - rest.len() + extra + consumed)
}

fn https_cmp_len(tail: &str) -> Option<usize> {
    let rest = tail
        .strip_prefix("!=")
        .or_else(|| tail.strip_prefix(".ne"))?;
    let op = tail.len() - rest.len();
    let body = rest.trim_start_matches('(');
    if !body.starts_with("\"https\"") {
        return None;
    }
    let mut end = op + (rest.len() - body.len()) + "\"https\"".len();
    let mut open = rest.len() - body.len();
    while open > 0 && tail.as_bytes().get(end) == Some(&b')') {
        end += 1;
        open -= 1;
    }
    Some(end)
}

fn args_of(at_paren: &str) -> Option<&str> {
    super::bind::call_inside(at_paren)
}

fn first_arg(args: &str) -> &str {
    super::bind::split_arg(args, true)
}

fn strip_ref(arg: &str) -> &str {
    super::bind::strip_ref(arg)
}

fn plain_ident(expr: &str) -> Option<&str> {
    super::bind::plain_ident(expr)
}

#[path = "guard_probes.rs"]
#[cfg(test)]
mod guard_probes;
