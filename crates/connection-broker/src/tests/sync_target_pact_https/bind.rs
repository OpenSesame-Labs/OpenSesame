//! Bind a credentialed dispatch to the URL its builder was given.
use super::super::sync_target_pact_norm::{is_keyword_at, string_len};
use super::strip_turbofish;

#[path = "bind_tail.rs"]
mod bind_tail;

pub(super) use super::mutate::shadows;
pub(super) use bind_tail::{call_tail, ident_prefix, is_single_eq, stmt_end, strip_ref};

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
            b')' | b']' if depth > 0 => depth -= 1,
            b'}' if depth > 0 => depth = close_block(bytes, depth, index, &mut start),
            b';' if depth == 0 => start = index + 1,
            b'=' if depth == 0 && is_single_eq(bytes, index) => start = index + 1,
            _ => {}
        }
        index += 1;
    }
    &source[start..dot]
}

/// `if decoy { return } request.send` starts a new statement at `}`.
/// `{ builder }.send` and `} else {` stay one expression.
fn close_block(bytes: &[u8], depth: i32, brace: usize, start: &mut usize) -> i32 {
    let depth = depth - 1;
    if depth == 0 && !expr_continues(bytes, brace + 1) {
        *start = brace + 1;
    }
    depth
}

/// `.` / `?` / `else` keep the block in the same expression.
fn expr_continues(bytes: &[u8], mut at: usize) -> bool {
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    if matches!(bytes.get(at), Some(b'.' | b'?')) {
        return true;
    }
    is_keyword_at(bytes, at, b"else")
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
        if let Some(end) = note_name_binding(prefix, index, name, &mut found) {
            index = end;
            continue;
        }
        index += 1;
    }
    found
}

fn note_name_binding(
    prefix: &str,
    index: usize,
    name: &str,
    found: &mut Option<String>,
) -> Option<usize> {
    let bytes = prefix.as_bytes();
    if !is_keyword_at(bytes, index, name.as_bytes()) {
        return None;
    }
    if let Some((url, end)) = super::pattern::destructured_url(prefix, index, name) {
        // `let (request,) = (client.get(evil),)` is a binding. An empty
        // URL still closes the unresolved-destination exception.
        *found = Some(url);
        return Some(end.max(index + 1));
    }
    let eq = eq_after_name(bytes, index + name.len())?;
    let end = stmt_end(bytes, eq + 1);
    apply_assigned_rhs(prefix, name, eq, end, found);
    Some(end.max(index + 1))
}

fn apply_assigned_rhs(prefix: &str, name: &str, eq: usize, end: usize, found: &mut Option<String>) {
    let rhs = &prefix[eq + 1..end];
    if let Some(url) = builder_url(rhs) {
        *found = Some(url.to_string());
        return;
    }
    // `request = other` supersedes a prior URL. `request = request.json(&body)`
    // keeps it: the chain root is still that binding.
    if ident_prefix(rhs.trim()) != name {
        *found = Some(String::new());
    }
}

/// `=` after `name`, skipping a type ascription (`let request: T =`).
pub(super) fn eq_after_name(bytes: &[u8], mut at: usize) -> Option<usize> {
    if bytes.get(at) == Some(&b':') && bytes.get(at + 1) != Some(&b':') {
        at = skip_ascription(bytes, at + 1);
    }
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    is_single_eq(bytes, at).then_some(at)
}

pub(super) fn builder_url(expr: &str) -> Option<&str> {
    marked_url(expr).or_else(|| call_arg_url(expr))
}

fn marked_url(expr: &str) -> Option<&str> {
    let bytes = expr.as_bytes();
    let mut index = 0usize;
    // Disagreeing branch URLs and unproven marks (`url.clone()`, `url,`) fail closed.
    let mut found: Option<&str> = None;
    let mut bad = false;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if let Some(at_paren) = builder_paren(expr, index) {
            let url = call_inside(&expr[at_paren..])
                .and_then(|inner| plain_ident(strip_ref(split_arg(inner, false))));
            bad |= !note_mark(&mut found, url);
        }
        index += 1;
    }
    if bad {
        Some("")
    } else {
        found
    }
}

/// `.get::<T>(` / `::request::<T>(`. A longer ident (`.get_mut`) is not a builder.
fn builder_paren(expr: &str, index: usize) -> Option<usize> {
    const METHODS: &[&str] = &["request", "get", "post", "put", "patch", "delete", "head"];
    let rest = &expr[index..];
    let sep = if rest.starts_with('.') {
        1
    } else if rest.starts_with("::") {
        2
    } else {
        return None;
    };
    let after_sep = &rest[sep..];
    let method = METHODS
        .iter()
        .copied()
        .find(|method| after_sep.starts_with(method))?;
    let method_end = index + sep + method.len();
    if expr
        .as_bytes()
        .get(method_end)
        .is_some_and(|byte| super::is_ident_byte(*byte))
    {
        return None;
    }
    let tail = &expr[method_end..];
    let after = strip_turbofish(tail).unwrap_or(tail);
    if !after.starts_with('(') {
        return None;
    }
    Some(method_end + (tail.len() - after.len()))
}

/// `false` when this mark disagrees with a URL already seen, or is unproven.
fn note_mark<'a>(found: &mut Option<&'a str>, url: Option<&'a str>) -> bool {
    match (*found, url) {
        (_, None) => false,
        (None, Some(url)) => {
            *found = Some(url);
            true
        }
        (Some(prev), Some(url)) => prev == url,
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
        if let Some(url) = free_call_url(expr, index) {
            found = Some(url);
        }
        index += 1;
    }
    found
}

fn free_call_url(expr: &str, index: usize) -> Option<&str> {
    if expr.as_bytes().get(index) != Some(&b'(') || !is_free_call(expr, index) {
        return None;
    }
    let inner = call_inside(&expr[index..])?;
    if call_arg_count(inner) != 1 {
        return None;
    }
    plain_ident(strip_ref(split_arg(inner, false)))
}

fn call_arg_count(args: &str) -> usize {
    let bytes = args.as_bytes();
    let (mut depth, mut index, mut start, mut count) = (0i32, 0usize, 0usize, 1usize);
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' if depth > 0 => depth -= 1,
            b',' if depth == 0 => {
                if !args[start..index].trim().is_empty() {
                    count += 1;
                }
                start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    if args[start..].trim().is_empty() && count > 1 {
        count -= 1;
    }
    count
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

pub(super) fn skip_ascription(bytes: &[u8], start: usize) -> usize {
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

#[cfg(test)]
mod probes {
    use super::super::credentialed_send_https_gaps;

    #[test]
    fn p5_decoy_scheme_after_builder_let_is_missing() {
        let sample = r#"async fn f() { let request = client.get(evil); if decoy.scheme() != "https" { return } request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
    }

    #[test]
    fn p5_turbofish_typed_let_and_branch_urls() {
        let fish = r#"async fn f() { if evil.scheme() != "https" { return Err("x".into()); } let request = client.get::<Body>(evil); request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(fish), (1, 0), "{fish}");
        let fish_decoy = r#"async fn f() { if decoy.scheme() != "https" { return Err("x".into()); } let request = client.get::<Body>(evil); request.send().await?; }"#;
        assert_eq!(
            credentialed_send_https_gaps(fish_decoy),
            (1, 1),
            "{fish_decoy}"
        );
        let typed = r#"async fn f() { if decoy.scheme() != "https" { return Err("x".into()); } let request: RequestBuilder = client.request::<Body>(method, evil); request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(typed), (1, 1), "{typed}");
        let branch = r#"async fn f() { let request = if cond { client.get(evil) } else { client.get(url) }; if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(branch), (1, 1), "{branch}");
        let same = r#"async fn f() { let request = if cond { client.get(url) } else { client.get(url) }; if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(same), (1, 0), "{same}");
    }
}
