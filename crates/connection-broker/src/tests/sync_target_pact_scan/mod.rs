//! Source scanner for credentialed sync response-body reads.
//!
//! `sync_target_production_for_scan` drops one brace-matched
//! `#[cfg(test)] mod unit_tests` block and keeps every other byte, including
//! production after that module. An unclosed module is not stripped, so a
//! later `#[cfg(test)]` cannot hide the tail. Patterns live here. Comments,
//! raw `r#` prefixes, and `use` items are normalized first; `as` aliases of
//! `read_bounded_body` / `response_guard` are recorded before the `use` goes.

/// Body reads on the credentialed sync path. The `request.json(&…)` call head
/// is removed and its payload stays visible. `Response::json`, `copy_to`, UFCS,
/// function items, and `response_guard` helpers (including `as` aliases) stay
/// forbidden.
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
        "::headers(",
        ".headers::<",
        "::headers::<",
        ".headers_mut(",
        "::headers_mut(",
        ".headers_mut::<",
        "::headers_mut::<",
        ".into_body(",
        "::into_body(",
        ".error_for_status(",
        "::error_for_status(",
        ".error_for_status_ref(",
        "::error_for_status_ref(",
        "response.into",
        "res.into",
        "upstream.into",
    ];
    let (alias_calls, alias_modules) =
        super::sync_target_pact_norm::response_reader_aliases(source);
    let response_type_aliases = pattern::response_type_aliases(source);
    let compact = super::sync_target_pact_norm::normalize_scan_source(source);
    let scanned = without_request_builder_json(&compact);
    let mut hits: Vec<&'static str> = PATTERNS
        .iter()
        .copied()
        .filter(|pattern| pattern::pattern_matches(&scanned, pattern, &response_type_aliases))
        .collect();
    if pattern::ufcs_body_function_items(&scanned)
        || pattern::dot_body_function_items(&scanned)
        || stream_consumption_reads(&scanned)
        || delegated_body_reader(&scanned)
        || delegated::passes_response_to_callee(&scanned, &response_type_aliases)
        || alias_reader(&scanned, &alias_calls, &alias_modules)
        || super::sync_target_pact_rename::response_into_read(&scanned)
        || super::sync_target_pact_rename::ufcs_response_move(&scanned)
        || block_into::block_into_read(&scanned)
        || alt_debug::alt_delim_debug_read(&scanned)
        || debug::response_metadata_reads(&scanned)
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
    calls
        .iter()
        .any(|name| pattern::contains_bounded(scanned, name))
        || modules
            .iter()
            .any(|name| pattern::has_path_segment(scanned, name))
}

fn stream_consumption_reads(scanned: &str) -> bool {
    stream::on_response(scanned) || super::sync_target_pact_chain::response_chain_consumer(scanned)
}

/// `read_bounded_body` and any `response_guard::` helper read provider bytes.
/// Renames are handled by `alias_reader` after `use` items are stripped.
fn delegated_body_reader(scanned: &str) -> bool {
    pattern::contains_bounded(scanned, "read_bounded_body")
        || pattern::has_path_segment(scanned, "response_guard")
}

mod alt_debug;
mod block_into;
mod debug;
mod delegated;
mod pattern;
mod stream;

pub(super) fn is_ident_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

/// Drop the `request.json` / `request.json::<T>` head and its parentheses.
/// The argument list stays, so `request.json(&response.text())` still shows the
/// body read. Dropping the parentheses keeps a later argument inside the
/// enclosing call (`helper(request.json(&payload), &response)`). Deleting the
/// arguments as well would hide that payload read. `.json` inside a string stays.
fn without_request_builder_json(compact: &str) -> String {
    let bytes = compact.as_bytes();
    let mut out = String::with_capacity(compact.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = super::sync_target_pact_norm::string_len(bytes, index) {
            out.push_str(&compact[index..index + len]);
            index += len;
            continue;
        }
        if let Some((inner, next)) = request_builder_json_args(compact, index) {
            out.push_str(&without_request_builder_json(inner));
            index = next;
            continue;
        }
        let ch = compact[index..].chars().next().unwrap();
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

/// Argument list of `request.json(&…)` at `index`, and the index after the call.
fn request_builder_json_args(compact: &str, index: usize) -> Option<(&str, usize)> {
    if !compact[index..].starts_with(".json") {
        return None;
    }
    if ident_before(&compact[..index]) != "request" {
        return None;
    }
    let after = &compact[index + ".json".len()..];
    let call = strip_compact_turbofish(after).unwrap_or(after);
    if !call.starts_with("(&") {
        return None;
    }
    let close = match_call_paren(call)?;
    let inner = &call[1..close];
    let next = compact.len() - call[close + 1..].len();
    Some((inner, next))
}

fn match_call_paren(call: &str) -> Option<usize> {
    let bytes = call.as_bytes();
    if bytes.first() != Some(&b'(') {
        return None;
    }
    let mut depth = 0i32;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = super::sync_target_pact_norm::string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

pub(super) fn strip_compact_turbofish(after: &str) -> Option<&str> {
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

#[cfg(test)]
mod probes {
    use super::response_body_reads;

    fn reads(sample: &str) -> bool {
        !response_body_reads(sample).is_empty()
    }

    #[test]
    fn council_p1_request_json_keeps_later_arguments() {
        let hits = [
            "helper(request.json(&payload), &response)",
            "helper(request.json::<T>(&payload), &response)",
            "helper(request.json(&foo(1)), &response)",
            "outer(request.json(&inner), \"x\", &response)",
            "helper(\"request.json(&payload\", &response)",
        ];
        for sample in hits {
            assert!(
                reads(sample),
                "builder json must not hide a later response argument: {sample}"
            );
        }
        let misses = [
            "request.json(&payload)",
            "request = request.json(&body);",
            "let _ = self.request.json(&body);",
            "request.json::<serde_json::Value>(&body)",
            "helper(request.json(&payload), status)",
        ];
        for sample in misses {
            assert!(
                !reads(sample),
                "builder json alone is not a body read: {sample}"
            );
        }
    }

    #[test]
    fn council_r3_request_json_keeps_payload_body_reads() {
        let hits = [
            "request.json(&response.text())",
            "request.json(&response.bytes())",
            "request.json::<T>(&response.text())",
            "request.json(&format!(\"{:?}\", response))",
            "request.json(&format!(\"{response:?}\"))",
            "helper(request.json(&response.text()), status)",
        ];
        for sample in hits {
            assert!(
                reads(sample),
                "payload body read must stay visible: {sample}"
            );
        }
        assert!(!reads(
            "request.json(&format!(\"{:?}\", response.status()))"
        ));
        assert!(!reads("request.json(&format!(\"{:?}\", status))"));
    }
}

pub(super) fn ident_before(prefix: &str) -> String {
    prefix
        .chars()
        .rev()
        .take_while(|c| is_ident_char(*c))
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}
