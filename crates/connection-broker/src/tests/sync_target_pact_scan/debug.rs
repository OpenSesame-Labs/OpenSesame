//! Response `Debug` and logging macros are provider metadata.

/// Provider metadata that `reqwest::Response` reflects without `.text()` / `.bytes()`.
/// `Debug` prints url, status, and headers. `error_for_status`'s `Display` includes
/// the HTTP/1 reason phrase. `Body::from` as a function item moves the body.
pub(super) fn response_metadata_reads(scanned: &str) -> bool {
    body_from_function_item(scanned)
        || named_debug_response(scanned)
        || macro_debug_response(scanned)
}

fn body_from_function_item(scanned: &str) -> bool {
    let mut offset = 0usize;
    while let Some(rel) = scanned[offset..].find("::from") {
        let index = offset + rel;
        let after = &scanned[index + "::from".len()..];
        if super::pattern::is_function_item_tail(after)
            && super::ident_before(&scanned[..index]) == "Body"
        {
            return true;
        }
        offset = index + "::from".len();
    }
    false
}

/// `{response:?}` / `{reply:#?}` inside a format string, including let-aliases.
fn named_debug_response(scanned: &str) -> bool {
    let bytes = scanned.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'{' {
            if let Some(name) = capture_debug_name(&scanned[index..]) {
                if super::super::sync_target_pact_rename::tracks_response_receiver(
                    scanned, index, name,
                ) {
                    return true;
                }
            }
        }
        index += 1;
    }
    false
}

fn capture_debug_name(tail: &str) -> Option<String> {
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

fn macro_debug_response(scanned: &str) -> bool {
    let bytes = scanned.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = super::super::sync_target_pact_norm::string_len(bytes, index) {
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
    if !MACROS.contains(&name.as_str()) {
        return false;
    }
    let Some(open) = macro_paren(scanned, bang) else {
        return false;
    };
    debug_macro_args(scanned, open, name == "dbg")
}

fn macro_name_before(source: &str, bang: usize) -> Option<String> {
    if bang == 0 {
        return None;
    }
    let name = super::ident_before(&source[..bang]);
    (!name.is_empty()).then_some(name)
}

fn macro_paren(source: &str, bang: usize) -> Option<usize> {
    let after = source[bang + 1..].trim_start();
    after
        .starts_with('(')
        .then_some(bang + 1 + (source[bang + 1..].len() - after.len()))
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
    let Some(name) = rhs_trim.strip_prefix('?') else {
        return false;
    };
    let name_at = trimmed_at + (trimmed.len() - rhs.len()) + (rhs.len() - rhs_trim.len()) + 1;
    arg_is_response(scanned, name, name_at)
}

/// `{r:?}` in the format string, with a later `r = response` argument.
fn named_format_is_response(scanned: &str, piece: &str, at: usize, captures: &[String]) -> bool {
    let Some((lhs, rhs)) = split_single_eq(piece) else {
        return false;
    };
    let lhs = lhs.trim();
    if !captures.iter().any(|name| name == lhs) {
        return false;
    }
    let rhs_at = at + (piece.len() - rhs.len());
    arg_is_response(scanned, rhs, rhs_at)
}

fn debug_capture_names(pieces: &[&str]) -> Vec<String> {
    let mut names = Vec::new();
    for piece in pieces {
        let bytes = piece.as_bytes();
        let mut index = 0usize;
        while index < bytes.len() {
            if bytes[index] == b'{' {
                if let Some(name) = capture_debug_name(&piece[index..]) {
                    if !names.iter().any(|have| have == &name) {
                        names.push(name);
                    }
                }
            }
            index += 1;
        }
    }
    names
}

fn split_single_eq(piece: &str) -> Option<(&str, &str)> {
    let bytes = piece.as_bytes();
    let mut depth = 0i32;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = super::super::sync_target_pact_norm::string_len(bytes, index) {
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

fn piece_has_debug_format(piece: &str) -> bool {
    piece.contains(":?") && piece.contains('"')
}

fn arg_is_response(scanned: &str, arg: &str, at: usize) -> bool {
    let arg = strip_ref_mut(arg.trim());
    let name: String = arg
        .chars()
        .take_while(|ch| super::is_ident_char(*ch))
        .collect();
    if name.is_empty() || !arg[name.len()..].trim().is_empty() {
        return false;
    }
    super::super::sync_target_pact_rename::tracks_response_receiver(scanned, at, name)
}

fn strip_ref_mut(arg: &str) -> &str {
    let mut arg = arg.trim();
    if let Some(rest) = arg.strip_prefix('&') {
        arg = rest.trim_start();
    }
    if let Some(rest) = arg.strip_prefix("mut") {
        if rest
            .chars()
            .next()
            .is_none_or(|ch| !super::is_ident_char(ch))
        {
            arg = rest.trim_start();
        }
    }
    arg
}

fn paren_inside_at(source: &str, open: usize) -> Option<&str> {
    let bytes = source.as_bytes();
    if bytes.get(open) != Some(&b'(') {
        return None;
    }
    let mut depth = 0i32;
    let mut index = open;
    while index < bytes.len() {
        if let Some(len) = super::super::sync_target_pact_norm::string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&source[open + 1..index]);
                }
            }
            _ => {}
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
        if let Some(len) = super::super::sync_target_pact_norm::string_len(bytes, index) {
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
