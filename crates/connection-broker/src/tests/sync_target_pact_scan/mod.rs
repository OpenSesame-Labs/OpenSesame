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
