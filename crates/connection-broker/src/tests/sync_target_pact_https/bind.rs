//! Bind a credentialed dispatch to the URL its builder was given.
use super::super::sync_target_pact_norm::{is_keyword_at, string_len};
use super::{is_ident_char, strip_turbofish};

pub(super) fn dispatch_url(source: &str, fn_start: usize, at: usize) -> Option<String> {
    let expr = request_expr(source, fn_start, at)?;
    if expr.is_empty() {
        return None;
    }
    if let Some(url) = builder_url(expr) {
        return Some(url.to_string());
    }
    let name = plain_receiver(expr)?;
    assigned_builder_url(&source[fn_start..at], name)
}

fn request_expr<'a>(source: &'a str, fn_start: usize, at: usize) -> Option<&'a str> {
    let rest = &source[at..];
    if rest.starts_with(".send") {
        return Some(receiver_expr(source, fn_start, at));
    }
    let args = if rest.starts_with(".execute") || rest.starts_with("::") {
        head_args(rest)?
    } else {
        let tail = super::super::sync_target_pact_chain::call_tail(source, at)?;
        call_inside(tail)?
    };
    let arg = split_arg(args, false);
    if !arg.is_empty() {
        return Some(arg);
    }
    rest.starts_with('.').then(|| receiver_expr(source, fn_start, at))
}

fn receiver_expr<'a>(source: &'a str, fn_start: usize, dot: usize) -> &'a str {
    let bytes = source.as_bytes();
    let (mut start, mut depth, mut index) = (fn_start + 1, 0i32, fn_start + 1);
    while index < dot {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' if depth > 0 => depth -= 1,
            b';' if depth == 0 => start = index + 1,
            b'=' if depth == 0 && is_single_eq(bytes, index) => start = index + 1,
            _ => {}
        }
        index += 1;
    }
    &source[start..dot]
}

fn assigned_builder_url(prefix: &str, name: &str) -> Option<String> {
    let bytes = prefix.as_bytes();
    let mut index = 0usize;
    let mut found = None;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if is_keyword_at(bytes, index, name.as_bytes()) {
            let eq = index + name.len();
            if is_single_eq(bytes, eq) {
                let end = stmt_end(bytes, eq + 1);
                if let Some(url) = builder_url(&prefix[eq + 1..end]) {
                    found = Some(url.to_string());
                }
                index = end;
                continue;
            }
        }
        index += 1;
    }
    found
}

fn builder_url(expr: &str) -> Option<&str> {
    const MARKS: &[&str] = &[
        ".request(",
        ".get(",
        ".post(",
        ".put(",
        ".patch(",
        ".delete(",
        ".head(",
        "::request(",
        "::get(",
        "::post(",
        "::put(",
        "::patch(",
        "::delete(",
        "::head(",
    ];
    let bytes = expr.as_bytes();
    let mut index = 0usize;
    let mut found = None;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if let Some(mark) = MARKS.iter().copied().find(|mark| expr[index..].starts_with(mark)) {
            let at_paren = index + mark.len() - 1;
            if let Some(inner) = call_inside(&expr[at_paren..]) {
                if let Some(url) = plain_ident(strip_ref(split_arg(inner, false))) {
                    found = Some(url);
                }
            }
        }
        index += 1;
    }
    found
}

fn head_args(rest: &str) -> Option<&str> {
    const HEADS: &[&str] = &["::execute", "::send", ".execute", ".send"];
    let head = HEADS.iter().copied().find(|head| rest.starts_with(head))?;
    let after = strip_turbofish(&rest[head.len()..]).unwrap_or(&rest[head.len()..]);
    call_inside(after)
}

pub(super) fn call_inside(at_paren: &str) -> Option<&str> {
    let bytes = at_paren.strip_prefix('(')?.as_bytes();
    let mut depth = 1i32;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
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

pub(super) fn split_arg(args: &str, first: bool) -> &str {
    let bytes = args.as_bytes();
    let (mut depth, mut index, mut start) = (0i32, 0usize, 0usize);
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' if depth > 0 => depth -= 1,
            b',' if depth == 0 => {
                if first {
                    return args[..index].trim();
                }
                start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    args[start..].trim()
}

pub(super) fn plain_ident(expr: &str) -> Option<&str> {
    let name = ident_prefix(expr);
    (name.len() == expr.len() && !name.is_empty()).then_some(name)
}

fn plain_receiver(expr: &str) -> Option<&str> {
    let mut expr = expr.trim();
    while let Some(inner) = expr.strip_prefix('(').and_then(|rest| rest.strip_suffix(')')) {
        expr = inner.trim();
    }
    let expr = expr.strip_prefix("&mut ").unwrap_or(expr);
    plain_ident(expr.strip_prefix('&').unwrap_or(expr).trim())
}

fn ident_prefix(expr: &str) -> &str {
    let end = expr
        .char_indices()
        .find(|(_, ch)| !is_ident_char(*ch))
        .map(|(index, _)| index)
        .unwrap_or(expr.len());
    &expr[..end]
}

pub(super) fn strip_ref(arg: &str) -> &str {
    arg.strip_prefix("&mut ")
        .or_else(|| arg.strip_prefix('&'))
        .unwrap_or(arg)
}

pub(super) fn is_single_eq(bytes: &[u8], index: usize) -> bool {
    bytes.get(index) == Some(&b'=')
        && bytes.get(index + 1) != Some(&b'=')
        && !matches!(
            index.checked_sub(1).and_then(|prev| bytes.get(prev)),
            Some(b'=' | b'!' | b'<' | b'>')
        )
}

pub(super) fn stmt_end(bytes: &[u8], start: usize) -> usize {
    let (mut depth, mut index) = (0i32, start);
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' if depth > 0 => depth -= 1,
            b';' if depth == 0 => return index,
            _ => {}
        }
        index += 1;
    }
    bytes.len()
}
