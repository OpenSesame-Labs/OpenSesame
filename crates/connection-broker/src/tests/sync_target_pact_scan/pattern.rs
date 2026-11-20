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
/// site is an allowlisted outbound `RequestBuilder::json` call. `.json(`
/// skips a prefix that ends in `:` so `Builder::json(` stays on the UFCS path.
pub(super) fn pattern_matches(
    scanned: &str,
    pattern: &str,
    response_type_aliases: &[String],
) -> bool {
    if pattern.starts_with("::json") {
        return ufcs_json_body_read(scanned, response_type_aliases);
    }
    if pattern == ".json(" {
        return dot_method_json_reads(scanned);
    }
    bounded_contains(scanned, pattern)
}

/// `contains`, but an identifier character at either end of `pattern` needs a
/// boundary. `res.into` does not match `res.into_inner` or `other_res.into`,
/// and `response.text()` does not match `http_response.text()`.
fn bounded_contains(haystack: &str, pattern: &str) -> bool {
    if pattern.is_empty() {
        return false;
    }
    let mut offset = 0usize;
    while let Some(rel) = haystack[offset..].find(pattern) {
        let index = offset + rel;
        if bounded_at(haystack, index, pattern) {
            return true;
        }
        offset = index + 1;
    }
    false
}

fn bounded_at(haystack: &str, index: usize, pattern: &str) -> bool {
    let before_ok = !starts_with_ident(pattern)
        || index == 0
        || !super::is_ident_char(char_before(&haystack[..index]));
    let end = index + pattern.len();
    let after_ok = !ends_with_ident(pattern)
        || end >= haystack.len()
        || !super::is_ident_char(char_at(haystack, end));
    before_ok && after_ok
}

fn starts_with_ident(pattern: &str) -> bool {
    pattern.chars().next().is_some_and(super::is_ident_char)
}

fn ends_with_ident(pattern: &str) -> bool {
    pattern
        .chars()
        .next_back()
        .is_some_and(super::is_ident_char)
}

/// `.json(` on a real receiver. `Type::json(` is UFCS, not a dot call.
fn dot_method_json_reads(scanned: &str) -> bool {
    let mut offset = 0;
    while let Some(rel) = scanned[offset..].find(".json(") {
        let index = offset + rel;
        if is_ufcs_json_prefix(&scanned[..index]) {
            offset = index + ".json(".len();
            continue;
        }
        let after = &scanned[index + ".json".len()..];
        if is_allowlisted_request_dot_json(&scanned[..index], after) {
            offset = index + 1;
            continue;
        }
        return true;
    }
    false
}

fn is_ufcs_json_prefix(prefix: &str) -> bool {
    prefix.trim_end().ends_with(':')
}

fn is_allowlisted_request_dot_json(prefix: &str, after: &str) -> bool {
    if super::ident_before(prefix) != "request" {
        return false;
    }
    let after = super::strip_compact_turbofish(after).unwrap_or(after);
    after.starts_with("(&")
}

fn ufcs_json_body_read(scanned: &str, response_type_aliases: &[String]) -> bool {
    let mut offset = 0;
    while let Some(rel) = scanned[offset..].find("::json") {
        let index = offset + rel;
        let after = &scanned[index + "::json".len()..];
        if after.starts_with('!') {
            offset = index + "::json".len();
            continue;
        }
        if is_allowlisted_ufcs_json_call(&scanned[..index], after, response_type_aliases) {
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
/// `RequestBuilder::json` are not that path. A `Response` imported under an
/// allowlisted name stays a body read.
fn is_allowlisted_ufcs_json_call(
    prefix: &str,
    after: &str,
    response_type_aliases: &[String],
) -> bool {
    let path = ufcs_type_path(prefix);
    if response_type_alias_path(path, response_type_aliases) {
        return false;
    }
    if !is_allowlisted_request_builder_path(path) {
        return false;
    }
    let after = super::strip_compact_turbofish(after).unwrap_or(after);
    allowlisted_builder_json_args(after)
}

/// `(request, &…)`, `(request,&…)`, and `(&request…)`. rustfmt leaves a space
/// after the comma; compact source sometimes does too.
fn allowlisted_builder_json_args(after: &str) -> bool {
    let Some(rest) = after.trim_start().strip_prefix('(') else {
        return false;
    };
    let rest = rest.trim_start();
    if let Some(rest) = rest.strip_prefix('&') {
        return rest.trim_start().starts_with("request");
    }
    let Some(rest) = rest.strip_prefix("request") else {
        return false;
    };
    if rest.chars().next().is_some_and(super::is_ident_char) {
        return false;
    }
    let Some(rest) = rest.trim_start().strip_prefix(',') else {
        return false;
    };
    rest.trim_start().starts_with('&')
}

pub(super) fn response_type_alias_path(path: &str, aliases: &[String]) -> bool {
    aliases.iter().any(|alias| {
        path == alias || {
            let angled = path
                .strip_prefix('<')
                .and_then(|rest| rest.strip_suffix('>'));
            angled == Some(alias)
        }
    })
}

pub(super) fn is_allowlisted_request_builder_path(path: &str) -> bool {
    matches!(
        path,
        "reqwest::RequestBuilder" | "<reqwest::RequestBuilder>" | "<RequestBuilder>"
    )
}

/// In-scope names introduced by `use …::Response as Alias`.
pub(super) fn response_type_aliases(source: &str) -> Vec<String> {
    let source = super::super::sync_target_pact_norm::strip_noise(source);
    let bytes = source.as_bytes();
    let mut aliases = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = super::super::sync_target_pact_norm::non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if super::super::sync_target_pact_norm::is_keyword_at(bytes, index, b"use") {
            let end = super::super::sync_target_pact_norm::skip_until_semi(bytes, index);
            let stmt_end = stmt_end_before_semi(bytes, end);
            let stmt = super::super::sync_target_pact_norm::compact_source(
                source[index + 3..stmt_end].trim(),
            );
            push_response_aliases(&stmt, "", &mut aliases);
            index = end;
            continue;
        }
        index += 1;
    }
    aliases
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
pub(super) fn ufcs_type_path(prefix: &str) -> &str {
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
    is_function_item_terminator(after.chars().next()) || is_as_cast(after)
}

/// `as Type`. `as_ref`, `async`, and `assert` are identifiers, not the cast keyword.
fn is_as_cast(after: &str) -> bool {
    let Some(rest) = after.strip_prefix("as") else {
        return false;
    };
    rest.chars()
        .next()
        .is_none_or(|ch| !super::is_ident_char(ch))
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

fn stmt_end_before_semi(bytes: &[u8], end: usize) -> usize {
    if end > 0 && bytes.get(end - 1) == Some(&b';') {
        end - 1
    } else {
        end
    }
}

fn push_response_aliases(tree: &str, prefix: &str, aliases: &mut Vec<String>) {
    let tree = tree.trim();
    if tree.is_empty() || tree == "*" {
        return;
    }
    if let Some((base, inner)) = split_use_group(tree) {
        let next = join_use_path(prefix, base);
        for item in split_use_items(inner) {
            push_response_aliases(item, &next, aliases);
        }
        return;
    }
    let (path, alias) = split_use_as(tree);
    let full = join_use_path(prefix, path);
    let tail = full.rsplit("::").next().unwrap_or(full.as_str()).trim();
    if tail == "Response" && !alias.is_empty() {
        aliases.push(alias.to_string());
    }
}

fn join_use_path(prefix: &str, path: &str) -> String {
    let path = path.trim();
    if prefix.is_empty() || path.is_empty() {
        return format!("{prefix}{path}");
    }
    format!("{prefix}::{path}")
}

fn split_use_group(tree: &str) -> Option<(&str, &str)> {
    let bytes = tree.as_bytes();
    let mut index = 0usize;
    while index + 2 < bytes.len() {
        if bytes[index..].starts_with(b"::{") {
            let close = super::super::sync_target_pact_norm::match_brace(bytes, index + 2)?;
            return Some((tree[..index].trim(), tree[index + 3..close].trim()));
        }
        index += 1;
    }
    None
}

fn split_use_items(inner: &str) -> Vec<&str> {
    let mut items = Vec::new();
    let (mut start, mut depth) = (0usize, 0i32);
    for (index, byte) in inner.bytes().enumerate() {
        match byte {
            b'{' | b'(' | b'[' | b'<' => depth += 1,
            b'}' | b')' | b']' | b'>' => depth -= 1,
            b',' if depth == 0 => {
                let item = inner[start..index].trim();
                if !item.is_empty() {
                    items.push(item);
                }
                start = index + 1;
            }
            _ => {}
        }
    }
    let item = inner[start..].trim();
    if !item.is_empty() {
        items.push(item);
    }
    items
}

fn split_use_as(item: &str) -> (&str, &str) {
    let bytes = item.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if super::super::sync_target_pact_norm::is_keyword_at(bytes, index, b"as") {
            let alias_region = item[index + 2..].trim_start();
            let alias = ident_at(alias_region);
            if !alias.is_empty() && alias_region[alias.len()..].trim().is_empty() {
                return (item[..index].trim(), alias);
            }
        }
        index += 1;
    }
    let path = item.trim();
    let alias = path.rsplit("::").next().unwrap_or(path).trim();
    (path, alias)
}

#[cfg(test)]
mod probes {
    use super::super::response_body_reads;

    fn reads(sample: &str) -> bool {
        !response_body_reads(sample).is_empty()
    }

    #[test]
    fn council_p1_pattern_ident_boundaries_and_as_keyword() {
        assert!(!super::pattern_matches(
            "http_response.text()",
            "response.text()",
            &[]
        ));
        assert!(!super::pattern_matches("res.into_inner()", "res.into", &[]));
        assert!(!super::pattern_matches("other_res.into()", "res.into", &[]));
        assert!(super::pattern_matches(
            "response.text()",
            "response.text()",
            &[]
        ));
        assert!(super::pattern_matches("res.into()", "res.into", &[]));
        assert!(super::pattern_matches(
            "http_response.text()",
            ".text(",
            &[]
        ));
        let misses = [
            "res.into_inner()",
            "other_res.into()",
            "let f = response.text as_ref;",
            "let f = Response::text as_ref;",
            "let f = Response::bytes async { 1 };",
            "let f = Response::copy_to assert(1);",
            "let f = response.headers as_ref();",
        ];
        for sample in misses {
            assert!(!reads(sample), "not a body read: {sample}");
        }
        let hits = [
            "res.into()",
            "response.into()",
            "response.text()",
            "http_response.text()",
            "let _f = Response::text as fn(&Response) -> _;",
            "let f = response.headers as fn();",
        ];
        for sample in hits {
            assert!(reads(sample), "body read: {sample}");
        }
    }

    #[test]
    fn council_r3_ufcs_json_allows_rustfmt_comma_space() {
        let aliases = Vec::new();
        assert!(super::is_allowlisted_ufcs_json_call(
            "reqwest::RequestBuilder",
            "(request, &body)",
            &aliases
        ));
        assert!(super::is_allowlisted_ufcs_json_call(
            "reqwest::RequestBuilder",
            "(request,&body)",
            &aliases
        ));
        assert!(super::is_allowlisted_ufcs_json_call(
            "<reqwest::RequestBuilder>",
            "::<Value>(request, &body)",
            &aliases
        ));
        assert!(super::is_allowlisted_ufcs_json_call(
            "<RequestBuilder>",
            "(&request, &body)",
            &aliases
        ));
        assert!(!super::is_allowlisted_ufcs_json_call(
            "reqwest::Response",
            "(request, &body)",
            &aliases
        ));
        assert!(!super::is_allowlisted_ufcs_json_call(
            "notreqwest::RequestBuilder",
            "(request, &body)",
            &aliases
        ));
        assert!(!super::is_allowlisted_ufcs_json_call(
            "reqwest::RequestBuilder",
            "(request_builder, &body)",
            &aliases
        ));
        assert!(!reads("reqwest::RequestBuilder::json(request, &body)"));
        assert!(!reads("reqwest::RequestBuilder::json(request,&body)"));
        assert!(reads("reqwest::RequestBuilder::json(response, &body)"));
    }
}

fn ident_at(source: &str) -> &str {
    let end = source
        .char_indices()
        .find(|(_, ch)| !super::is_ident_char(*ch))
        .map(|(index, _)| index)
        .unwrap_or(source.len());
    &source[..end]
}
