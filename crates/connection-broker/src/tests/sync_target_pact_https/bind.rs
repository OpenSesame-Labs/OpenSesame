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
        let tail = call_tail(source, at)?;
        call_inside(tail)?
    };
    let arg = split_arg(args, false);
    if !arg.is_empty() {
        return Some(arg);
    }
    rest.starts_with('.')
        .then(|| receiver_expr(source, fn_start, at))
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
                let rhs = &prefix[eq + 1..end];
                if let Some(url) = builder_url(rhs) {
                    found = Some(url.to_string());
                } else if ident_prefix(rhs.trim()) != name {
                    // `request = other` supersedes a prior URL. `request = request.json(&body)`
                    // keeps it: the chain root is still that binding.
                    found = Some(String::new());
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
    marked_url(expr).or_else(|| call_arg_url(expr))
}

fn marked_url(expr: &str) -> Option<&str> {
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
    // `Some(None)` is an unproven URL (`url.clone()`, `url,`). The last mark wins.
    let mut found: Option<Option<&str>> = None;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if let Some(mark) = MARKS
            .iter()
            .copied()
            .find(|mark| expr[index..].starts_with(mark))
        {
            let at_paren = index + mark.len() - 1;
            let url = call_inside(&expr[at_paren..])
                .and_then(|inner| plain_ident(strip_ref(split_arg(inner, false))));
            found = Some(url);
        }
        index += 1;
    }
    match found {
        Some(Some(url)) => Some(url),
        Some(None) => Some(""),
        None => None,
    }
}

/// Last plain-ident argument of a free function call (`build_request(other)`).
/// Method calls (`.json(&body)`) do not choose the URL.
fn call_arg_url(expr: &str) -> Option<&str> {
    let bytes = expr.as_bytes();
    let mut index = 0usize;
    let mut found = None;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes[index] == b'(' && is_free_call(expr, index) {
            if let Some(inner) = call_inside(&expr[index..]) {
                if let Some(url) = plain_ident(strip_ref(split_arg(inner, false))) {
                    found = Some(url);
                }
            }
        }
        index += 1;
    }
    found
}

fn is_free_call(expr: &str, paren: usize) -> bool {
    let bytes = expr.as_bytes();
    if paren == 0 || !super::is_ident_byte(bytes[paren - 1]) {
        return false;
    }
    let mut start = paren;
    while start > 0 && super::is_ident_byte(bytes[start - 1]) {
        start -= 1;
    }
    start == 0 || bytes[start - 1] != b'.'
}

/// `name` is assigned or updated in place, so the checked value is not the sent one.
/// `url = evil` is an assignment. `set_scheme`, `clone_from`, `push_str`, and any
/// other call on that binding mutate it without `=`. `mem::swap` does too.
pub(super) fn shadows(source: &str, name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let bytes = source.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if is_keyword_at(bytes, index, name.as_bytes())
            && (assigns_name(bytes, index + name.len()) || mutates_name(source, index + name.len()))
        {
            return true;
        }
        if mem_swap_touches(source, index, name) {
            return true;
        }
        index += 1;
    }
    false
}

/// `.set_scheme(…)`, `.clone_from(…)`, `.push_str(…)`, and any other call.
fn mutates_name(source: &str, mut at: usize) -> bool {
    let bytes = source.as_bytes();
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    if bytes.get(at) != Some(&b'.') {
        return false;
    }
    at += 1;
    if at >= bytes.len() || !super::is_ident_byte(bytes[at]) {
        return false;
    }
    while at < bytes.len() && super::is_ident_byte(bytes[at]) {
        at += 1;
    }
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    bytes.get(at) == Some(&b'(') || source[at..].starts_with("::")
}

fn mem_swap_touches(source: &str, index: usize, name: &str) -> bool {
    const MARK: &str = "mem::swap";
    if !source[index..].starts_with(MARK) {
        return false;
    }
    let bytes = source.as_bytes();
    if index > 0 && super::is_ident_byte(bytes[index - 1]) {
        return false;
    }
    let Some(args) = call_inside(&source[index + MARK.len()..]) else {
        return false;
    };
    swap_args_include(args, name)
}

fn swap_args_include(args: &str, name: &str) -> bool {
    let bytes = args.as_bytes();
    let (mut depth, mut index, mut start) = (0i32, 0usize, 0usize);
    let mut hit = false;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' if depth > 0 => depth -= 1,
            b',' if depth == 0 => {
                hit |= arg_is_name(&args[start..index], name);
                start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    hit || arg_is_name(&args[start..], name)
}

fn arg_is_name(arg: &str, name: &str) -> bool {
    plain_ident(strip_ref(arg.trim())) == Some(name)
}

fn assigns_name(bytes: &[u8], mut at: usize) -> bool {
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    if bytes.get(at) == Some(&b':') && bytes.get(at + 1) != Some(&b':') {
        at = skip_ascription(bytes, at + 1);
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
    }
    is_single_eq(bytes, at)
}

fn skip_ascription(bytes: &[u8], start: usize) -> usize {
    let mut depth = 0i32;
    let mut index = start;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' if depth > 0 => depth -= 1,
            b'=' | b',' | b';' if depth == 0 => return index,
            _ => {}
        }
        index += 1;
    }
    index
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
    while let Some(inner) = expr
        .strip_prefix('(')
        .and_then(|rest| rest.strip_suffix(')'))
    {
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
        && !matches!(bytes.get(index + 1), Some(b'=' | b'>'))
        && !matches!(
            index.checked_sub(1).and_then(|prev| bytes.get(prev)),
            Some(b'=' | b'!' | b'<' | b'>')
        )
}

/// Argument list opener for `name(…)` and `(name)(…)` alias dispatches.
pub(super) fn call_tail(source: &str, at: usize) -> Option<&str> {
    let rest = &source[at..];
    let name_len = leading_ident(rest).len();
    if name_len == 0 {
        return None;
    }
    let mut tail = rest[name_len..].trim_start();
    if tail.starts_with('(') {
        return Some(tail);
    }
    loop {
        let Some(stripped) = tail.strip_prefix(')') else {
            break;
        };
        tail = strip_turbofish(stripped).unwrap_or(stripped).trim_start();
        if tail.starts_with('(') {
            return Some(tail);
        }
        if !tail.starts_with(')') {
            break;
        }
    }
    None
}

fn leading_ident(source: &str) -> &str {
    let end = source
        .char_indices()
        .find(|(_, ch)| !is_ident_char(*ch))
        .map(|(index, _)| index)
        .unwrap_or(source.len());
    &source[..end]
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
