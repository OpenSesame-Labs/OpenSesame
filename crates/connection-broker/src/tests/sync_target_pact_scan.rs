//! Source scanner for credentialed sync response-body reads.
//!
//! `sync_target_production_for_scan` drops one brace-matched
//! `#[cfg(test)] mod unit_tests` block and keeps every other byte, including
//! production after that module. An unclosed module is not stripped, so a
//! later `#[cfg(test)]` cannot hide the tail. Patterns live here. Comments,
//! raw `r#` prefixes, and `use` items are normalized first; `as` aliases of
//! `read_bounded_body` / `response_guard` are recorded before the `use` goes.

/// Body reads on the credentialed sync path. `request.json(&…)` builder calls
/// are removed. `Response::json`, `copy_to`, UFCS, function items, and
/// `response_guard` helpers (including `as` aliases) stay forbidden.
pub(crate) fn response_body_reads(source: &str) -> Vec<&'static str> {
    const PATTERNS: &[&str] = &[
        "response.text()",
        "response.bytes()",
        "response.json",
        "response.chunk",
        ".text(",
        ".bytes(",
        ".chunk(",
        ".bytes_stream(",
        ".text_with_charset(",
        ".copy_to(",
        ".copy_to::<",
        ".json(",
        ".json::<",
        "::text(",
        "::bytes(",
        "::json",
        "::chunk(",
        "::bytes_stream(",
        "::text_with_charset(",
        "::copy_to::<",
        "::copy_to(",
        ".headers(",
        "response.into",
        "res.into",
        "upstream.into",
    ];
    let (alias_calls, alias_modules) =
        super::sync_target_pact_norm::response_reader_aliases(source);
    let compact = super::sync_target_pact_norm::normalize_scan_source(source);
    let scanned = without_request_builder_json(&compact);
    let mut hits: Vec<&'static str> = PATTERNS
        .iter()
        .copied()
        .filter(|pattern| pattern_matches(&scanned, pattern))
        .collect();
    if ufcs_body_function_items(&scanned)
        || dot_body_function_items(&scanned)
        || stream_consumption_reads(&scanned)
        || delegated_body_reader(&scanned)
        || alias_reader(&scanned, &alias_calls, &alias_modules)
    {
        hits.push("::text;");
    }
    hits
}

const UNIT_TESTS_HEADER: &str = "#[cfg(test)]\nmod unit_tests";

/// Production `sync_target.rs`. Only the brace-matched `mod unit_tests` block
/// is removed. Code after it is still compiled outside `cfg(test)`, so it stays
/// in the scan. A later `#[cfg(test)]` is left in place rather than used as a
/// second cut. If the module's braces do not close, the source is unchanged.
pub(crate) fn sync_target_production_for_scan(source: &str) -> String {
    let Some(at) = unit_tests_header_at(source) else {
        return source.to_string();
    };
    let from = at + UNIT_TESTS_HEADER.len();
    let bytes = source.as_bytes();
    let Some(open) = super::sync_target_pact_norm::find_code_byte(bytes, from, b'{') else {
        return source.to_string();
    };
    let Some(close) = super::sync_target_pact_norm::match_brace(bytes, open) else {
        return source.to_string();
    };
    let mut suffix = &source[close + 1..];
    if suffix.trim().is_empty() {
        suffix = "";
    }
    let mut out = String::with_capacity(source.len());
    out.push_str(&source[..at]);
    out.push_str(suffix);
    out
}

fn unit_tests_header_at(source: &str) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = super::sync_target_pact_norm::non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if source[index..].starts_with(UNIT_TESTS_HEADER) {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn alias_reader(scanned: &str, calls: &[String], modules: &[String]) -> bool {
    calls.iter().any(|name| contains_bounded(scanned, name))
        || modules.iter().any(|name| has_path_segment(scanned, name))
}

fn stream_consumption_reads(scanned: &str) -> bool {
    const MARKERS: &[&str] = &[
        ".next(",
        ".try_next(",
        ".poll_next(",
        ".poll_next_unpin(",
        "::poll_next_unpin(",
        ".try_poll_next_unpin(",
        "::try_poll_next_unpin(",
        ".for_each(",
        "::for_each(",
        ".fold(",
        "try_fold",
        "::next(",
        "::collect(",
        "StreamExt::next",
        "StreamExt::for_each",
        "StreamExt::count(",
        "StreamExt::count::",
        "try_collect",
        "try_for_each",
    ];
    if MARKERS.iter().any(|marker| scanned.contains(marker)) {
        return true;
    }
    super::sync_target_pact_chain::response_chain_consumer(scanned)
}

/// `read_bounded_body` and any `response_guard::` helper read provider bytes.
/// Renames are handled by `alias_reader` after `use` items are stripped.
fn delegated_body_reader(scanned: &str) -> bool {
    contains_bounded(scanned, "read_bounded_body") || has_path_segment(scanned, "response_guard")
}

fn has_path_segment(haystack: &str, ident: &str) -> bool {
    let marker = format!("{ident}::");
    let mut offset = 0;
    while let Some(rel) = haystack[offset..].find(&marker) {
        let index = offset + rel;
        if index == 0 || !is_ident_char(char_before(&haystack[..index])) {
            return true;
        }
        offset = index + marker.len();
    }
    false
}

/// `.name(` matches any receiver. `::json` is a body read unless the UFCS
/// site is an allowlisted `RequestBuilder::json` call.
fn pattern_matches(scanned: &str, pattern: &str) -> bool {
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
    let after = strip_compact_turbofish(after).unwrap_or(after);
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
fn contains_bounded(haystack: &str, token: &str) -> bool {
    let mut offset = 0;
    while let Some(rel) = haystack[offset..].find(token) {
        let index = offset + rel;
        let before_ok = index == 0 || !is_ident_char(char_before(&haystack[..index]));
        let end = index + token.len();
        let after_ok = end == haystack.len() || !is_ident_char(char_at(haystack, end));
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

fn is_ident_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
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
        if is_ident_char(ch) {
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

fn is_function_item_tail(after: &str) -> bool {
    let after = after.trim_start();
    if after.starts_with('(') {
        return false;
    }
    let after = strip_compact_turbofish(after).unwrap_or(after).trim_start();
    if after.starts_with('(') {
        return false;
    }
    is_function_item_terminator(after.chars().next()) || after.starts_with("as")
}

/// `.name` function items (`response.text`, `request.json`). Calls stay out.
/// `request.json` is not exempt; only `without_request_builder_json` removes
/// builder `.json(&…)` calls.
fn dot_body_function_items(scanned: &str) -> bool {
    body_function_items(scanned, ".")
}

/// `Response::text;` and `Resp::bytes` function items, not call syntax.
fn ufcs_body_function_items(scanned: &str) -> bool {
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

/// Remove `request.json(&…)` / `request.json::<T>(&…)` call syntax only.
fn without_request_builder_json(compact: &str) -> String {
    let mut out = String::with_capacity(compact.len());
    let mut rest = compact;
    while let Some(index) = rest.find(".json") {
        let receiver_is_request = ident_before(&rest[..index]) == "request";
        out.push_str(&rest[..index]);
        let after = &rest[index + ".json".len()..];
        if receiver_is_request {
            if let Some(kept) = after_request_builder_json(after) {
                rest = kept;
                continue;
            }
        }
        out.push_str(".json");
        rest = after;
    }
    out.push_str(rest);
    out
}

/// Source following `RequestBuilder::json`'s `(&` argument, if `after` is that call.
fn after_request_builder_json(after: &str) -> Option<&str> {
    let after = strip_compact_turbofish(after).unwrap_or(after);
    after.strip_prefix("(&")
}

fn strip_compact_turbofish(after: &str) -> Option<&str> {
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

fn ident_before(prefix: &str) -> String {
    prefix
        .chars()
        .rev()
        .take_while(|c| is_ident_char(*c))
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}
