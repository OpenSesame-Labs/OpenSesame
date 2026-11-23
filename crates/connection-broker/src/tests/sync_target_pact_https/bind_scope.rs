//! Branch merge and `else` recognition for URL bindings.
use super::super::super::sync_target_pact_norm::{is_keyword_at, non_code_len};
use super::{builder_url, eq_after_name, ident_prefix, stmt_end, BraceKind, UrlBinding};

pub(super) fn merge_partial(entry: &[UrlBinding], branch: &[UrlBinding]) -> Vec<UrlBinding> {
    if visible_url(entry) == visible_url(branch) {
        return branch.to_vec();
    }
    fail_closed(entry)
}

pub(super) fn merge_both(
    entry: &[UrlBinding],
    left: &[UrlBinding],
    right: &[UrlBinding],
) -> Vec<UrlBinding> {
    if visible_url(left) == visible_url(right) {
        return right.to_vec();
    }
    fail_closed(entry)
}

pub(super) fn fail_closed(entry: &[UrlBinding]) -> Vec<UrlBinding> {
    let mut out = entry.to_vec();
    if let Some(binding) = out.last_mut() {
        binding.url.clear();
        return out;
    }
    out.push(UrlBinding {
        depth: 0,
        url: String::new(),
        is_let: false,
    });
    out
}

fn visible_url(layers: &[UrlBinding]) -> Option<&str> {
    layers.last().map(|binding| binding.url.as_str())
}

pub(super) fn else_follows(source: &str, at: usize) -> bool {
    else_at(source.as_bytes(), at).is_some()
}

/// Position of the `else` keyword at or after `at`, skipping whitespace,
/// comments, and strings.
fn else_at(bytes: &[u8], mut at: usize) -> Option<usize> {
    loop {
        if let Some(len) = non_code_len(bytes, at) {
            at += len;
            continue;
        }
        if bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
            at += 1;
            continue;
        }
        return is_keyword_at(bytes, at, b"else").then_some(at);
    }
}

/// Position just after the `else` keyword at or after `at`, skipping
/// whitespace, comments, and strings.
fn after_else_keyword(bytes: &[u8], at: usize) -> Option<usize> {
    let keyword_at = else_at(bytes, at)?;
    let mut after = keyword_at + "else".len();
    loop {
        if let Some(len) = non_code_len(bytes, after) {
            after += len;
            continue;
        }
        if bytes.get(after).is_some_and(u8::is_ascii_whitespace) {
            after += 1;
            continue;
        }
        break;
    }
    Some(after)
}

/// `else` with neither a block nor an `if` after it. Only a diverging arm
/// (`else return;` / `else break;` / `else continue;`) cannot fall through,
/// so only those keep the if-arm exit as the sole live state. A braceless
/// expression arm (`else request = client.get(url);`) is legal Rust and
/// falls through like an `else` block: the arm merge must still run, or the
/// forward scan overwrites the if-arm exit with the else-arm URL.
pub(super) fn braceless_else(source: &str, at: usize) -> bool {
    let bytes = source.as_bytes();
    let Some(after) = after_else_keyword(bytes, at) else {
        return false;
    };
    match bytes.get(after) {
        Some(b'{') => false,
        Some(_) => ["return", "break", "continue"]
            .iter()
            .any(|keyword| is_keyword_at(bytes, after, keyword.as_bytes())),
        None => true,
    }
}

/// A non-diverging braceless arm is exactly one statement: its end is the
/// arm's `;`, where the arm merge must run even with no `{` to close it.
pub(super) fn else_arm_end(source: &str, at: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let after = after_else_keyword(bytes, at)?;
    Some(stmt_end(bytes, after))
}

pub(super) fn brace_kind(source: &str, brace: usize) -> BraceKind {
    let bytes = source.as_bytes();
    let at = code_end_before(source, brace);
    if at >= 2 && bytes[at - 2] == b'=' && bytes[at - 1] == b'>' {
        return BraceKind::Branch;
    }
    let header = &source[header_start(source, at)..at];
    match first_header_keyword(header) {
        Some("else") if header_has_keyword(header, "if") => BraceKind::ElseIf,
        Some("else") => BraceKind::Else,
        Some("if" | "while" | "for" | "loop" | "match") => BraceKind::Branch,
        _ => BraceKind::Block,
    }
}

/// `;` / `{` / `}` inside a comment or string is not a header break: the scan
/// walks code bytes only, so `if /* ; */ cond {` keeps its `if` header.
fn header_start(source: &str, end: usize) -> usize {
    let bytes = source.as_bytes();
    let mut at = end;
    let mut depth = 0i32;
    while at > 0 {
        let Some(prev) = prev_code_byte(bytes, at) else {
            return 0;
        };
        match bytes[prev] {
            b')' | b']' => depth += 1,
            b'(' | b'[' if depth > 0 => depth -= 1,
            b';' | b'{' | b'}' if depth == 0 => return prev + 1,
            _ => {}
        }
        at = prev;
    }
    0
}

/// End of the code span before `end`: whitespace, comments, and strings
/// against `end` are skipped, so `=> /* c */ {` still reads the `=>` and a
/// trailing comment's `=>` cannot fake a match arm.
fn code_end_before(source: &str, end: usize) -> usize {
    let bytes = source.as_bytes();
    let mut index = 0usize;
    let mut last = 0usize;
    while index < end {
        if let Some(len) = non_code_len(bytes, index) {
            let span_end = index + len;
            if span_end >= end {
                break;
            }
            index = span_end;
            continue;
        }
        let ch = source[index..].chars().next().expect("char at byte index");
        if !ch.is_whitespace() {
            last = index + ch.len_utf8();
        }
        index += ch.len_utf8();
    }
    last
}

/// Largest index of a code byte strictly before `end`.
fn prev_code_byte(bytes: &[u8], end: usize) -> Option<usize> {
    let mut index = 0usize;
    let mut last = None;
    while index < end {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        last = Some(index);
        index += 1;
    }
    last
}

fn first_header_keyword(header: &str) -> Option<&str> {
    const KEYS: &[&str] = &["else", "if", "while", "for", "loop", "match"];
    let bytes = header.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        for key in KEYS {
            if is_keyword_at(bytes, index, key.as_bytes()) {
                return Some(*key);
            }
        }
        index += 1;
    }
    None
}

fn header_has_keyword(header: &str, keyword: &str) -> bool {
    let bytes = header.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if is_keyword_at(bytes, index, keyword.as_bytes()) {
            return true;
        }
        index += 1;
    }
    false
}

pub(super) struct Noted {
    pub(super) url: String,
    pub(super) end: usize,
    pub(super) is_let: bool,
}

pub(super) fn note_binding(
    prefix: &str,
    index: usize,
    name: &str,
    previous: Option<&str>,
) -> Option<Noted> {
    let bytes = prefix.as_bytes();
    if !is_keyword_at(bytes, index, name.as_bytes()) {
        return None;
    }
    if let Some((url, end, is_let)) = super::super::pattern::destructured_url(prefix, index, name) {
        // `let (request,) = (client.get(evil),)` is a binding; a bare tuple
        // reassignment rebinds it like an assignment. An empty URL still
        // closes the unresolved-destination exception.
        return Some(Noted {
            url,
            end: end.max(index + 1),
            is_let,
        });
    }
    let eq = eq_after_name(bytes, index + name.len())?;
    let end = stmt_end(bytes, eq + 1);
    let url = rhs_url(prefix, name, eq, end, previous)?;
    Some(Noted {
        url,
        end: end.max(index + 1),
        is_let: binding_introduced_by_let(prefix, index),
    })
}

fn rhs_url(
    prefix: &str,
    name: &str,
    eq: usize,
    end: usize,
    previous: Option<&str>,
) -> Option<String> {
    let rhs = &prefix[eq + 1..end];
    if let Some(url) = builder_url(rhs) {
        return Some(url.to_string());
    }
    // `request = other` supersedes a prior URL. `request = request.json(&body)`
    // keeps it: the chain root is still that binding.
    if ident_prefix(rhs.trim()) == name {
        return previous.map(str::to_string);
    }
    Some(String::new())
}

fn binding_introduced_by_let(prefix: &str, name_at: usize) -> bool {
    let before = strip_trailing_mut(prefix[..name_at].trim_end());
    ends_with_keyword(before, "let")
}

fn strip_trailing_mut(before: &str) -> &str {
    let Some(rest) = before.strip_suffix("mut") else {
        return before;
    };
    if rest
        .chars()
        .next_back()
        .is_some_and(super::super::is_ident_char)
    {
        return before;
    }
    rest.trim_end()
}

fn ends_with_keyword(source: &str, keyword: &str) -> bool {
    source.strip_suffix(keyword).is_some_and(|rest| {
        rest.chars()
            .next_back()
            .is_none_or(|ch| !super::super::is_ident_char(ch))
    })
}

#[path = "bind_scope_probes.rs"]
#[cfg(test)]
mod probes;
