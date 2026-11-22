//! `Response::upgrade` hands the caller the provider-controlled byte stream.
//!
//! `response.upgrade().await?` (and its UFCS form) is an ownership escape like
//! `.into_body()`: what follows reads provider bytes, so the discard contract
//! must treat it as a response-body read.
use super::super::sync_target_pact_norm::string_len;
use super::super::sync_target_pact_rename::strip_turbofish as rename_strip_turbofish;
use super::super::sync_target_pact_rename::{args_track_response, method_receiver_is_response};

pub(super) fn upgrade_escapes_response(scanned: &str) -> bool {
    dot_upgrade_on_response(scanned) || ufcs_upgrade_on_response(scanned)
}

fn dot_upgrade_on_response(scanned: &str) -> bool {
    let bytes = scanned.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes[index] == b'.'
            && scanned[index + 1..].starts_with("upgrade")
            && upgrade_call_open(scanned, index + 1)
            && method_receiver_is_response(scanned, index)
        {
            return true;
        }
        index += 1;
    }
    false
}

fn upgrade_call_open(scanned: &str, at: usize) -> bool {
    let after = &scanned[at + "upgrade".len()..];
    if after.chars().next().is_some_and(super::is_ident_char) {
        return false;
    }
    let peeled = rename_strip_turbofish(after.trim_start());
    peeled.starts_with('(')
}

fn ufcs_upgrade_on_response(scanned: &str) -> bool {
    let bytes = scanned.as_bytes();
    let mut index = 0usize;
    while index + 1 < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if scanned[index..].starts_with("::") && ufcs_upgrade_call_tracks(scanned, index) {
            return true;
        }
        index += 1;
    }
    false
}

fn ufcs_upgrade_call_tracks(scanned: &str, colons: usize) -> bool {
    let rest = &scanned[colons + 2..];
    if !rest.starts_with("upgrade")
        || rest["upgrade".len()..]
            .chars()
            .next()
            .is_some_and(super::is_ident_char)
    {
        return false;
    }
    let after = rest["upgrade".len()..].trim_start();
    let peeled = rename_strip_turbofish(after);
    if !peeled.starts_with('(') {
        return false;
    }
    let open = colons + 2 + "upgrade".len() + (after.len() - peeled.len());
    args_track_response(scanned, open)
}

#[cfg(test)]
mod probes {
    use crate::tests::sync_target_pact_scan::response_body_reads;

    fn reads(sample: &str) -> bool {
        !response_body_reads(sample).is_empty()
    }

    #[test]
    fn codex_thread_response_upgrade_is_an_ownership_escape() {
        let hits = [
            "let mut stream = response.upgrade().await?; stream.read_to_end(&mut output).await?;",
            "response.upgrade().await?",
            "reqwest::Response::upgrade(response).await?",
            "Response::upgrade(&mut response)",
            "let reply = response; reply.upgrade().await?",
        ];
        for sample in hits {
            assert!(reads(sample), "upgrade exports provider bytes: {sample}");
        }
        let misses = [
            "socket.upgrade().await?",
            "let upgraded = other.upgrade();",
            "upgrade::apply(response)",
        ];
        for sample in misses {
            assert!(
                !reads(sample),
                "unrelated upgrade is not a body read: {sample}"
            );
        }
    }
}
