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
        || block_into_read(&scanned)
        || alt_delim_debug_read(&scanned)
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
        "::try_next(",
        "::fold(",
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
    pattern::contains_bounded(scanned, "read_bounded_body")
        || pattern::has_path_segment(scanned, "response_guard")
}

/// `{response}.into()` moves the provider body. Paren receivers stay in rename.
fn block_into_read(scanned: &str) -> bool {
    each_code_marker(scanned, ".into", block_into_at)
}

fn block_into_at(scanned: &str, index: usize) -> bool {
    let after = &scanned[index + ".into".len()..];
    if after.chars().next().is_some_and(is_ident_char) {
        return false;
    }
    let after = super::sync_target_pact_rename::strip_turbofish(after);
    if !after.starts_with('(') {
        return false;
    }
    let prefix = scanned[..index].trim_end();
    if !prefix.ends_with('}') {
        return false;
    }
    let Some(open) = prefix.rfind('{') else {
        return false;
    };
    let inner = prefix[open + 1..prefix.len() - 1].trim();
    let Some(name) = super::sync_target_pact_rename::plain_name(inner) else {
        return false;
    };
    let at = open + 1 + inner_name_at(prefix, open, &name);
    super::sync_target_pact_rename::tracks_response_receiver(scanned, at, name)
}

fn inner_name_at(prefix: &str, open: usize, name: &str) -> usize {
    let body = &prefix[open + 1..];
    let trimmed = body.trim_start();
    let lead = body.len() - trimmed.len();
    lead + trimmed.find(name).unwrap_or(0)
}

/// `dbg![response]` and `format!{"{:?}", response}`. Paren macros stay in debug.
fn alt_delim_debug_read(scanned: &str) -> bool {
    let bytes = scanned.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = super::sync_target_pact_norm::string_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes[index] == b'!' && alt_debug_at(scanned, index) {
            return true;
        }
        index += 1;
    }
    false
}

fn alt_debug_at(scanned: &str, bang: usize) -> bool {
    const MACROS: &[&str] = &["format", "format_args", "println", "eprintln", "dbg"];
    let name = ident_before(&scanned[..bang]);
    if !MACROS.contains(&name.as_str()) {
        return false;
    }
    let raw = &scanned[bang + 1..];
    let after = raw.trim_start();
    if !after.starts_with('[') && !after.starts_with('{') && !after.starts_with('(') {
        return false;
    }
    let open = bang + 1 + (raw.len() - after.len());
    let Some(args) = group_inside(scanned, open) else {
        return false;
    };
    let bracket = after.starts_with('[') || after.starts_with('{');
    let debug_fmt = name == "dbg" || args.contains(":?");
    if bracket && debug_fmt && group_args_track_response(scanned, args, open) {
        return true;
    }
    compare_tail_is_response(scanned, args, open)
}

/// `format!("{:?}", a < b, response)` keeps the response arg after `<`.
fn compare_tail_is_response(scanned: &str, args: &str, open: usize) -> bool {
    if !args.contains(":?") || !code_contains_lt(args) {
        return false;
    }
    let Some(raw_tail) = args.rsplit(',').next() else {
        return false;
    };
    let tail = raw_tail.trim();
    let name: String = tail.chars().take_while(|ch| is_ident_char(*ch)).collect();
    if name.is_empty() || !tail[name.len()..].trim().is_empty() {
        return false;
    }
    let at = open + 1 + args.rfind(tail).unwrap_or(0);
    super::sync_target_pact_rename::tracks_response_receiver(scanned, at, name)
}

fn code_contains_lt(args: &str) -> bool {
    let bytes = args.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = super::sync_target_pact_norm::string_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes[index] == b'<' {
            return true;
        }
        index += 1;
    }
    false
}

fn group_args_track_response(scanned: &str, args: &str, open: usize) -> bool {
    let mut offset = 0usize;
    for piece in split_top_args(args) {
        if piece.is_empty() {
            continue;
        }
        let Some(rel) = args[offset..].find(piece) else {
            continue;
        };
        let at = open + 1 + offset + rel;
        if piece_tracks_response(scanned, piece, at) {
            return true;
        }
        offset += rel + piece.len();
    }
    false
}

fn piece_tracks_response(scanned: &str, piece: &str, at: usize) -> bool {
    let Some(name) = super::sync_target_pact_rename::plain_name(piece) else {
        return false;
    };
    let lead = piece.len() - piece.trim_start().len();
    let within = piece.trim_start();
    let name_at = at + lead + within.find(name.as_str()).unwrap_or(0);
    super::sync_target_pact_rename::tracks_response_receiver(scanned, name_at, name)
}

fn split_top_args(args: &str) -> Vec<&str> {
    let bytes = args.as_bytes();
    let (mut depth, mut index, mut start) = (0i32, 0usize, 0usize);
    let mut out = Vec::new();
    while index < bytes.len() {
        if let Some(len) = super::sync_target_pact_norm::string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' if depth > 0 => depth -= 1,
            b',' if depth == 0 => {
                out.push(args[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    out.push(args[start..].trim());
    out
}

fn group_inside(source: &str, open: usize) -> Option<&str> {
    let bytes = source.as_bytes();
    let (open_byte, close_byte) = match bytes.get(open) {
        Some(b'(') => (b'(', b')'),
        Some(b'[') => (b'[', b']'),
        Some(b'{') => (b'{', b'}'),
        _ => return None,
    };
    let mut depth = 0i32;
    let mut index = open;
    while index < bytes.len() {
        if let Some(len) = super::sync_target_pact_norm::string_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes[index] == open_byte {
            depth += 1;
        } else if bytes[index] == close_byte {
            depth -= 1;
            if depth == 0 {
                return Some(&source[open + 1..index]);
            }
        }
        index += 1;
    }
    None
}

fn each_code_marker(scanned: &str, marker: &str, mut hit: impl FnMut(&str, usize) -> bool) -> bool {
    let bytes = scanned.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = super::sync_target_pact_norm::string_len(bytes, index) {
            index += len;
            continue;
        }
        if scanned[index..].starts_with(marker) && hit(scanned, index) {
            return true;
        }
        index += 1;
    }
    false
}

mod debug;
mod delegated;
mod pattern;

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
