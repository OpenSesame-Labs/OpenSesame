//! Macro `Debug` reads with paren, bracket, and brace delimiters.

use super::capture_debug_name;
use crate::tests::sync_target_pact_norm::string_len;
use crate::tests::sync_target_pact_rename;
use crate::tests::sync_target_pact_scan::ident_before;

pub(super) fn macro_debug_response(scanned: &str) -> bool {
    let bytes = scanned.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes[index] == b'!' && debug_macro_at(scanned, index) {
            return true;
        }
        index += 1;
    }
    false
}

fn debug_macro_at(scanned: &str, bang: usize) -> bool {
    const MACROS: &[&str] = &[
        "format",
        "format_args",
        "println",
        "eprintln",
        "print",
        "eprint",
        "writeln",
        "write",
        "panic",
        "dbg",
        "info",
        "debug",
        "warn",
        "error",
        "trace",
        "event",
        "anyhow",
        "bail",
        "eyre",
    ];
    let Some(name) = macro_name_before(scanned, bang) else {
        return false;
    };
    let Some(open) = macro_paren(scanned, bang) else {
        return false;
    };
    if !MACROS.contains(&name.as_str()) {
        // An imported or project-specific macro (`audit!`, `emit!`, …) can
        // format and export provider metadata as well as any logging name.
        // Conservatively flag it when an argument carries a tracked response;
        // unrelated macros (`vec![1]`) stay clear.
        return unknown_macro_tracks_response(scanned, open);
    }
    debug_macro_args(scanned, open, name == "dbg")
}

/// Macros outside the known logging list are reads when any argument, named
/// format capture, or tracing field carries a credentialed response receiver.
fn unknown_macro_tracks_response(scanned: &str, open: usize) -> bool {
    let Some(args) = paren_inside_at(scanned, open) else {
        return false;
    };
    let pieces = split_args(args);
    let captures = debug_capture_names(&pieces);
    let mut offset = 0usize;
    for piece in &pieces {
        if piece.is_empty() {
            continue;
        }
        let Some(rel) = args[offset..].find(piece) else {
            continue;
        };
        let at = open + 1 + offset + rel;
        if arg_is_response(scanned, piece, at)
            || named_format_is_response(scanned, piece, at, &captures)
            || capture_names_track_response(scanned, at, &captures)
            || tracing_piece_is_response(scanned, piece, at)
        {
            return true;
        }
        offset += rel + piece.len();
    }
    false
}

fn macro_name_before(source: &str, bang: usize) -> Option<String> {
    if bang == 0 {
        return None;
    }
    let name = ident_before(&source[..bang]);
    (!name.is_empty()).then_some(name)
}

fn macro_paren(source: &str, bang: usize) -> Option<usize> {
    let raw = &source[bang + 1..];
    let after = raw.trim_start();
    let delim = after.chars().next()?;
    if !matches!(delim, '(' | '[' | '{') {
        return None;
    }
    Some(bang + 1 + (raw.len() - after.len()))
}

fn debug_macro_args(scanned: &str, open: usize, dbg_macro: bool) -> bool {
    let Some(args) = paren_inside_at(scanned, open) else {
        return false;
    };
    let pieces = split_args(args);
    if pieces_have_tracing_debug(scanned, args, open, &pieces) {
        return true;
    }
    let debug_fmt = dbg_macro || pieces.iter().any(|piece| piece_has_debug_format(piece));
    if !debug_fmt {
        return false;
    }
    let captures = debug_capture_names(&pieces);
    let mut offset = 0usize;
    for piece in &pieces {
        if piece.is_empty() {
            continue;
        }
        let Some(rel) = args[offset..].find(piece) else {
            continue;
        };
        let at = open + 1 + offset + rel;
        if arg_is_response(scanned, piece, at)
            || named_format_is_response(scanned, piece, at, &captures)
            || capture_names_track_response(scanned, at, &captures)
        {
            return true;
        }
        offset += rel + piece.len();
    }
    false
}

/// `tracing::info!(?response)` and `info!(field = ?response)`.
fn pieces_have_tracing_debug(scanned: &str, args: &str, open: usize, pieces: &[&str]) -> bool {
    let mut offset = 0usize;
    for piece in pieces {
        if piece.is_empty() {
            continue;
        }
        let Some(rel) = args[offset..].find(piece) else {
            continue;
        };
        let at = open + 1 + offset + rel;
        if tracing_piece_is_response(scanned, piece, at) {
            return true;
        }
        offset += rel + piece.len();
    }
    false
}

fn tracing_piece_is_response(scanned: &str, piece: &str, at: usize) -> bool {
    let trimmed = piece.trim();
    let trimmed_at = at + (piece.len() - trimmed.len());
    if let Some(name) = trimmed.strip_prefix('?') {
        return arg_is_response(scanned, name, trimmed_at + 1);
    }
    let Some((_, rhs)) = split_single_eq(trimmed) else {
        return false;
    };
    let rhs_trim = rhs.trim_start();
    let name_at = trimmed_at + (trimmed.len() - rhs.len()) + (rhs.len() - rhs_trim.len());
    if let Some(name) = rhs_trim.strip_prefix('?') {
        return arg_is_response(scanned, name, name_at + 1);
    }
    // `field = response`: the tracked receiver is the argument itself.
    arg_is_response(scanned, rhs_trim, name_at)
}

/// `{r:?}` in the format string, with a later `r = response` argument.
fn capture_names_track_response(scanned: &str, at: usize, captures: &[String]) -> bool {
    captures
        .iter()
        .any(|name| sync_target_pact_rename::tracks_response_receiver(scanned, at, name.clone()))
}

fn named_format_is_response(scanned: &str, piece: &str, at: usize, captures: &[String]) -> bool {
    let Some((lhs, rhs)) = split_single_eq(piece) else {
        return false;
    };
    let lhs = lhs.trim();
    if !captures.iter().any(|name| name == lhs) {
        return false;
    }
    let rhs_at = at + (piece.len() - rhs.len());
    let trimmed = rhs.trim_start();
    let lead = rhs.len() - trimmed.len();
    arg_is_response(scanned, trimmed, rhs_at + lead)
}

fn debug_capture_names(pieces: &[&str]) -> Vec<String> {
    let mut names = Vec::new();
    for piece in pieces {
        push_capture_names(&mut names, piece);
    }
    names
}

fn push_capture_names(names: &mut Vec<String>, piece: &str) {
    let bytes = piece.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        push_capture_at(names, piece, index);
        index += 1;
    }
}

fn push_capture_at(names: &mut Vec<String>, piece: &str, index: usize) {
    if piece.as_bytes().get(index) != Some(&b'{') {
        return;
    }
    let Some(name) = capture_debug_name(&piece[index..]) else {
        return;
    };
    if names.iter().any(|have| have == &name) {
        return;
    }
    names.push(name);
}

fn split_single_eq(piece: &str) -> Option<(&str, &str)> {
    let bytes = piece.as_bytes();
    let mut depth = 0i32;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' if depth > 0 => depth -= 1,
            b'=' if depth == 0 && is_single_eq_byte(bytes, index) => {
                return Some((&piece[..index], &piece[index + 1..]));
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn is_single_eq_byte(bytes: &[u8], index: usize) -> bool {
    bytes.get(index) == Some(&b'=')
        && !matches!(bytes.get(index + 1), Some(b'=' | b'>'))
        && !matches!(
            index.checked_sub(1).and_then(|prev| bytes.get(prev)),
            Some(b'=' | b'!' | b'<' | b'>')
        )
}

/// `{:?}` and the pretty-debug `{:#?}` both expand the value's body into the
/// format string (Kimi council chunk07 P1).
fn piece_has_debug_format(piece: &str) -> bool {
    (piece.contains(":?") || piece.contains(":#?")) && piece.contains('"')
}

fn arg_is_response(scanned: &str, arg: &str, at: usize) -> bool {
    let Some(name) = sync_target_pact_rename::plain_name(arg) else {
        return false;
    };
    // `dbg!(&response)` and `r = response` must track the ident, not the `&` or space.
    let name_at = at + ident_offset(arg, &name);
    sync_target_pact_rename::tracks_response_receiver(scanned, name_at, name)
}

fn ident_offset(arg: &str, name: &str) -> usize {
    let lead = arg.len() - arg.trim_start().len();
    let within = arg.trim_start();
    lead + within.find(name).unwrap_or(0)
}

fn paren_inside_at(source: &str, open: usize) -> Option<&str> {
    macro_inside_at(source, open)
}

fn macro_inside_at(source: &str, open: usize) -> Option<&str> {
    let bytes = source.as_bytes();
    let (open_b, close_b) = match bytes.get(open)? {
        b'(' => (b'(', b')'),
        b'[' => (b'[', b']'),
        b'{' => (b'{', b'}'),
        _ => return None,
    };
    let mut depth = 0i32;
    let mut index = open;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes[index] == open_b {
            depth += 1;
        } else if bytes[index] == close_b {
            depth -= 1;
            if depth == 0 {
                return Some(&source[open + 1..index]);
            }
        }
        index += 1;
    }
    None
}

fn split_args(args: &str) -> Vec<&str> {
    let bytes = args.as_bytes();
    let (mut depth, mut index, mut start) = (0i32, 0usize, 0usize);
    let mut out = Vec::new();
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
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

#[path = "debug_probes.rs"]
#[cfg(test)]
mod probes;
