//! Response `Debug` and logging macros are provider metadata.
//!
//! `.url()` and `.content_length()` are the same metadata: reqwest's `Debug`
//! prints the URL, and the declared length is the representation the production
//! pact refuses to depend on. Method calls, UFCS, and function items are flagged.

/// Provider metadata that `reqwest::Response` reflects without `.text()` / `.bytes()`.
/// `Debug` prints url, status, and headers. `error_for_status`'s `Display` includes
/// the HTTP/1 reason phrase. `Body::from` as a function item moves the body.
pub(super) fn response_metadata_reads(scanned: &str) -> bool {
    body_from_function_item(scanned)
        || named_debug_response(scanned)
        || macro_read::macro_debug_response(scanned)
        || provider_metadata_accessor(scanned)
}

const METADATA_ACCESSORS: &[&str] = &["url", "content_length"];

fn provider_metadata_accessor(scanned: &str) -> bool {
    METADATA_ACCESSORS
        .iter()
        .any(|name| dot_accessor(scanned, name) || ufcs_accessor(scanned, name))
}

fn dot_accessor(scanned: &str, name: &str) -> bool {
    let marker = format!(".{name}");
    each_marker(scanned, &marker, |index, _, after| {
        accessor_tail(after)
            && super::super::sync_target_pact_rename::method_receiver_is_response(scanned, index)
    })
}

fn ufcs_accessor(scanned: &str, name: &str) -> bool {
    let marker = format!("::{name}");
    each_marker(scanned, &marker, |index, end, after| {
        ufcs_accessor_at(scanned, index, end, after)
    })
}

fn ufcs_accessor_at(scanned: &str, index: usize, end: usize, after: &str) -> bool {
    let typed = super::super::sync_target_pact_rename::ufcs_type_is_response(&scanned[..index]);
    if let Some(rel) = opened_paren(after) {
        return typed
            || super::super::sync_target_pact_rename::args_track_response(scanned, end + rel);
    }
    typed && super::pattern::is_function_item_tail(after)
}

fn accessor_tail(after: &str) -> bool {
    opened_paren(after).is_some() || super::pattern::is_function_item_tail(after)
}

fn opened_paren(after: &str) -> Option<usize> {
    let trimmed = after.trim_start();
    let peeled = super::super::sync_target_pact_rename::strip_turbofish(trimmed);
    peeled
        .starts_with('(')
        .then_some(after.len() - peeled.len())
}

fn each_marker(
    scanned: &str,
    marker: &str,
    mut hit: impl FnMut(usize, usize, &str) -> bool,
) -> bool {
    let bytes = scanned.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = super::super::sync_target_pact_norm::string_len(bytes, index) {
            index += len;
            continue;
        }
        if scanned[index..].starts_with(marker) && marker_hit(marker, index, scanned, &mut hit) {
            return true;
        }
        index += 1;
    }
    false
}

fn marker_hit(
    marker: &str,
    index: usize,
    scanned: &str,
    hit: &mut impl FnMut(usize, usize, &str) -> bool,
) -> bool {
    let end = index + marker.len();
    let after = &scanned[end..];
    !after.chars().next().is_some_and(super::is_ident_char) && hit(index, end, after)
}

fn body_from_function_item(scanned: &str) -> bool {
    body_from_direct_call(scanned)
        || body_from_item_sites(scanned)
        || body_from_alias_calls(scanned)
}

/// `let f = Body::from;` and `pass(Body::from)` move the body. Same rule as
/// `let f = Response::url;`: the function item is the read, not only a later call.
fn body_from_item_sites(scanned: &str) -> bool {
    each_marker(scanned, "::from", |index, _, after| {
        super::ident_before(&scanned[..index]) == "Body"
            && super::pattern::is_function_item_tail(after)
    })
}

fn body_from_direct_call(scanned: &str) -> bool {
    each_marker(scanned, "::from", |index, end, after| {
        super::ident_before(&scanned[..index]) == "Body"
            && opened_paren(after).is_some_and(|rel| {
                super::super::sync_target_pact_rename::args_track_response(scanned, end + rel)
            })
    })
}

fn body_from_alias_calls(scanned: &str) -> bool {
    let aliases = body_from_aliases(scanned);
    if aliases.is_empty() {
        return false;
    }
    let bytes = scanned.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = super::super::sync_target_pact_norm::string_len(bytes, index) {
            index += len;
            continue;
        }
        for alias in &aliases {
            if source_calls_alias(scanned, index, alias) {
                return true;
            }
        }
        index += 1;
    }
    false
}

fn body_from_aliases(scanned: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut offset = 0usize;
    while let Some(rel) = scanned[offset..].find("::from") {
        let index = offset + rel;
        let after = &scanned[index + "::from".len()..];
        if super::ident_before(&scanned[..index]) == "Body"
            && super::pattern::is_function_item_tail(after)
        {
            if let Some(name) =
                super::super::sync_target_pact_let::binding_name_before(&scanned[..index])
            {
                if !names.iter().any(|have| have == &name) {
                    names.push(name);
                }
            }
        }
        offset = index + "::from".len();
    }
    names
}

fn source_calls_alias(scanned: &str, index: usize, alias: &str) -> bool {
    if index > 0 {
        let prev = scanned[..index].chars().next_back().unwrap();
        if super::is_ident_char(prev) {
            return false;
        }
    }
    if !scanned[index..].starts_with(alias) {
        return false;
    }
    let raw_after = &scanned[index + alias.len()..];
    let peeled = super::super::sync_target_pact_rename::strip_turbofish(raw_after.trim_start());
    if !peeled.starts_with('(') {
        return false;
    }
    let open = index + alias.len() + (raw_after.len() - peeled.len());
    super::super::sync_target_pact_rename::args_track_response(scanned, open)
}

/// `{response:?}` / `{reply:#?}` inside a format string, including let-aliases.
fn named_debug_response(scanned: &str) -> bool {
    let bytes = scanned.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = super::super::sync_target_pact_norm::string_len(bytes, index) {
            index += len;
            continue;
        }
        if debug_name_at(scanned, index) {
            return true;
        }
        index += 1;
    }
    false
}

fn debug_name_at(scanned: &str, index: usize) -> bool {
    if scanned.as_bytes()[index] != b'{' {
        return false;
    }
    let Some(name) = capture_debug_name(&scanned[index..]) else {
        return false;
    };
    super::super::sync_target_pact_rename::tracks_response_receiver(scanned, index, name)
}

pub(super) fn capture_debug_name(tail: &str) -> Option<String> {
    let rest = tail.strip_prefix('{')?;
    let name: String = rest
        .chars()
        .take_while(|ch| super::is_ident_char(*ch))
        .collect();
    if name.is_empty() {
        return None;
    }
    let after = &rest[name.len()..];
    (after.starts_with(":?}") || after.starts_with(":#?}")).then_some(name)
}

#[path = "debug_macro.rs"]
mod macro_read;
