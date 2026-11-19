//! Body-read patterns, UFCS allowlists, and function-item tails.

pub(super) fn has_path_segment(haystack: &str, ident: &str) -> bool {
    let marker = format!("{ident}::");
    let mut offset = 0;
    while let Some(rel) = haystack[offset..].find(&marker) {
        let index = offset + rel;
        if index == 0 || !super::is_ident_char(char_before(&haystack[..index])) {
            return true;
        }
        offset = index + marker.len();
    }
    false
}

/// `.name(` matches any receiver. `::json` is a body read unless the UFCS
/// site is an allowlisted `RequestBuilder::json` call.
pub(super) fn pattern_matches(scanned: &str, pattern: &str) -> bool {
    if pattern.starts_with("::json") {
        return ufcs_json_body_read(scanned);
    }
    scanned.contains(pattern)
}

fn ufcs_json_body_read(scanned: &str) -> bool {
    let mut offset = 0;
    while let Some(rel) = scanned[offset..].find("::json") {
        let index = offset + rel;
        let after = &scanned[index + "::json".len()..];
        if after.starts_with('!') {
            offset = index + "::json".len();
            continue;
        }
        if is_allowlisted_ufcs_json_call(&scanned[..index], after) {
            offset = index + "::json".len();
            continue;
        }
        if after.starts_with('(') || after.starts_with("::<") {
            return true;
        }
        offset = index + "::json".len();
    }
    false
}

/// Allow only the UFCS type path at this `::json` site, never a `RequestBuilder`
/// mention earlier in the file. `foo::<RequestBuilder>` and a bare alias
/// `RequestBuilder::json` are not that path.
fn is_allowlisted_ufcs_json_call(prefix: &str, after: &str) -> bool {
    if !is_allowlisted_request_builder_path(ufcs_type_path(prefix)) {
        return false;
    }
    let after = super::strip_compact_turbofish(after).unwrap_or(after);
    after.starts_with("(request,&") || after.starts_with("(&request")
}

fn is_allowlisted_request_builder_path(path: &str) -> bool {
    matches!(
        path,
        "reqwest::RequestBuilder" | "<reqwest::RequestBuilder>" | "<RequestBuilder>"
    )
}

/// `token` occurs in `path` on an identifier boundary. `<` and `>` are part of
/// the `<RequestBuilder>` token, so `Vec<RequestBuilder>` does not match it
/// (`c` before `<` is an identifier character).
pub(super) fn contains_bounded(haystack: &str, token: &str) -> bool {
    let mut offset = 0;
    while let Some(rel) = haystack[offset..].find(token) {
        let index = offset + rel;
        let before_ok = index == 0 || !super::is_ident_char(char_before(&haystack[..index]));
        let end = index + token.len();
        let after_ok = end == haystack.len() || !super::is_ident_char(char_at(haystack, end));
        if before_ok && after_ok {
            return true;
        }
        offset = end;
    }
    false
}

fn char_before(prefix: &str) -> char {
    prefix.chars().next_back().unwrap_or('\0')
}

fn char_at(source: &str, index: usize) -> char {
    source[index..].chars().next().unwrap_or('\0')
}

/// Type expression immediately before `::method`, including `<...>` groups.
fn ufcs_type_path(prefix: &str) -> &str {
    let mut index = prefix.len();
    let mut angle_depth = 0i32;
    while index > 0 {
        let ch = char_before(&prefix[..index]);
        let ch_len = ch.len_utf8();
        if angle_depth > 0 {
            if ch == '>' {
                angle_depth += 1;
            } else if ch == '<' {
                angle_depth -= 1;
            }
            index -= ch_len;
            continue;
        }
        if super::is_ident_char(ch) {
            index -= ch_len;
            continue;
        }
        if ch == '>' {
            angle_depth += 1;
            index -= ch_len;
            continue;
        }
        if ch == ':' && prefix[..index - ch_len].ends_with(':') {
            index -= ch_len + ':'.len_utf8();
            continue;
        }
        break;
    }
    &prefix[index..]
}

fn is_function_item_terminator(next: Option<char>) -> bool {
    matches!(next, Some(';' | ')' | ',' | ']' | '}') | None)
}

pub(super) fn is_function_item_tail(after: &str) -> bool {
    let after = after.trim_start();
    if after.starts_with('(') {
        return false;
    }
    let after = super::strip_compact_turbofish(after)
        .unwrap_or(after)
        .trim_start();
    if after.starts_with('(') {
        return false;
    }
    is_function_item_terminator(after.chars().next()) || after.starts_with("as")
}

/// `.name` function items (`response.text`, `request.json`). Calls stay out.
/// `request.json` is not exempt; only `without_request_builder_json` removes
/// builder `.json(&…)` calls.
pub(super) fn dot_body_function_items(scanned: &str) -> bool {
    body_function_items(scanned, ".")
}

/// `Response::text;` and `Resp::bytes` function items, not call syntax.
pub(super) fn ufcs_body_function_items(scanned: &str) -> bool {
    body_function_items(scanned, "::")
}

fn body_function_items(scanned: &str, separator: &str) -> bool {
    const METHODS: &[&str] = &[
        "text",
        "bytes",
        "chunk",
        "bytes_stream",
        "text_with_charset",
        "json",
        "copy_to",
        "headers",
        "headers_mut",
        "into_body",
        "error_for_status",
        "error_for_status_ref",
    ];
    for method in METHODS {
        let marker = format!("{separator}{method}");
        let mut offset = 0;
        while let Some(rel) = scanned[offset..].find(&marker) {
            let index = offset + rel;
            let after = &scanned[index + marker.len()..];
            if is_function_item_tail(after) {
                return true;
            }
            offset = index + marker.len();
        }
    }
    false
}
