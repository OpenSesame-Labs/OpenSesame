//! `{response}.into()` block-tail reads.
use super::super::sync_target_pact_norm::string_len;
use super::super::sync_target_pact_rename;

pub(super) fn block_into_read(scanned: &str) -> bool {
    each_code_marker(scanned, ".into", block_into_at)
}

fn block_into_at(scanned: &str, index: usize) -> bool {
    let after = &scanned[index + ".into".len()..];
    if after.chars().next().is_some_and(super::is_ident_char) {
        return false;
    }
    let after = sync_target_pact_rename::strip_turbofish(after);
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
    let Some(name) = sync_target_pact_rename::plain_name(inner) else {
        return false;
    };
    let at = open + 1 + inner_name_at(prefix, open, &name);
    sync_target_pact_rename::tracks_response_receiver(scanned, at, name)
}

fn inner_name_at(prefix: &str, open: usize, name: &str) -> usize {
    let body = &prefix[open + 1..];
    let trimmed = body.trim_start();
    let lead = body.len() - trimmed.len();
    lead + trimmed.find(name).unwrap_or(0)
}

fn each_code_marker(scanned: &str, marker: &str, mut hit: impl FnMut(&str, usize) -> bool) -> bool {
    let bytes = scanned.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
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
