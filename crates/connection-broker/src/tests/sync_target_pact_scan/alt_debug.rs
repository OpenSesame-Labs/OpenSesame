//! `dbg![response]` and other non-paren macro delimiters.
use super::super::sync_target_pact_norm::string_len;
use super::super::sync_target_pact_rename::{plain_name, tracks_response_receiver};

pub(super) fn alt_delim_debug_read(scanned: &str) -> bool {
    let bytes = scanned.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
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
    let name = super::ident_before(&scanned[..bang]);
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

fn compare_tail_is_response(scanned: &str, args: &str, open: usize) -> bool {
    if !args.contains(":?") || !code_contains_lt(args) {
        return false;
    }
    let Some(raw_tail) = args.rsplit(',').next() else {
        return false;
    };
    let tail = raw_tail.trim();
    let name: String = tail.chars().take_while(|ch| super::is_ident_char(*ch)).collect();
    if name.is_empty() || !tail[name.len()..].trim().is_empty() {
        return false;
    }
    let at = open + 1 + args.rfind(tail).unwrap_or(0);
    tracks_response_receiver(scanned, at, name)
}

fn code_contains_lt(args: &str) -> bool {
    let bytes = args.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
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
    let Some(name) = plain_name(piece) else {
        return false;
    };
    let lead = piece.len() - piece.trim_start().len();
    let within = piece.trim_start();
    let name_at = at + lead + within.find(name.as_str()).unwrap_or(0);
    tracks_response_receiver(scanned, name_at, name)
}

fn split_top_args(args: &str) -> Vec<&str> {
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
        if let Some(len) = string_len(bytes, index) {
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