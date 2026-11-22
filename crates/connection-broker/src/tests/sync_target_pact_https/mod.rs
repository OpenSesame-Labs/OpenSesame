//! HTTPS guard for credentialed sync dispatch.
//!
//! A dispatch is `.send` / `::send` / `.execute` / `::execute`, or a later call
//! through `let f = …::send`, including a binding forwarded from that alias
//! (`let call = dispatch`), a later reassignment (`call = dispatch`), a block
//! expression (`let call = { dispatch }`), and a one-element tuple
//! (`let (dispatch,) = (…::send,)`). The guarding `if` must `return` from that
//! function (not from a closure) and must dominate the send: a scheme `if`
//! nested in another `if`, and an `else if`, do not cover a send that still
//! runs when that branch is skipped. A call on the bound URL after the check
//! (`set_scheme`, `clone_from`, `push_str`, `mem::swap`, `mem::replace`,
//! UFCS `Url::set_scheme`, a rebinding `&mut` alias, a tuple assignment
//! `(url,) = …`, or any other call) voids the guard. `&&` / `||` split before
//! unary `!`. A guard on a different URL does not count. A tuple or
//! destructured `let (request,) = …` is a real binding, so an unrelated
//! scheme check is not a guard for that send.
//!
//! Unresolved destinations are an intentional exception. When the scanner
//! cannot bind the sent URL — a free `request.send()` or `client.execute(request)`
//! with no local builder — tests accept a free-floating `parsed.scheme() != "https"`
//! predicate in that function as the guard. `http_provider_json` does not use
//! that exception: it parses `url`, checks `parsed.scheme()`, and sends that
//! same `url`, so the production contract stays `sends >= 1` and `missing == 0`.

mod bind;
mod closure;
mod guard;
mod mutate;
mod pattern;
mod sqlx_exec;

pub(crate) use closure::closure_owns;

use super::sync_target_pact_norm::string_len;

/// `(sends, missing)` for credentialed dispatch sites.
pub(crate) fn credentialed_send_https_gaps(source: &str) -> (usize, usize) {
    let source = super::sync_target_pact_norm::compact_source(
        &super::sync_target_pact_norm::strip_noise(source),
    );
    let bytes = source.as_bytes();
    let spans = super::sync_target_pact_norm::function_spans(bytes);
    let alias_calls = super::sync_target_pact_chain::dispatch_alias_calls(&source);
    let mut sends = 0usize;
    let mut missing = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if !source.is_char_boundary(index) {
            index += 1;
            continue;
        }
        if let Some(len) = dispatch_site(&source, &alias_calls, index) {
            if credentialed_dispatch_site(&source, index) {
                sends += 1;
                if !scheme_guarded(&source, &spans, index) {
                    missing += 1;
                }
            }
            index += len;
            continue;
        }
        // A free call that receives a locally built request (`transmit(request)`)
        // owns it: the wrapper can dispatch the credential wherever it wants,
        // so the escape counts as a send bound to that builder's URL.
        let Some((fn_start, _)) = innermost_span(&spans, index) else {
            index += 1;
            continue;
        };
        if let Some((len, url)) = bind::ownership_escape(&source, fn_start, index) {
            sends += 1;
            if !guard::guarded(&source[fn_start..index], Some(&url)) {
                missing += 1;
            }
            index += len;
            continue;
        }
        index += 1;
    }
    (sends, missing)
}

fn credentialed_dispatch_site(source: &str, index: usize) -> bool {
    let rest = &source[index..];
    if !rest.starts_with(".execute") {
        return true;
    }
    !sqlx_exec::receiver_is_sqlx(source, index)
}

fn dispatch_site(source: &str, alias_calls: &[(usize, usize)], index: usize) -> Option<usize> {
    dispatch_len(&source[index..]).or_else(|| {
        alias_calls
            .iter()
            .find(|(at, _)| *at == index)
            .map(|(_, len)| *len)
    })
}

fn scheme_guarded(source: &str, spans: &[(usize, usize)], index: usize) -> bool {
    let Some((start, _)) = innermost_span(spans, index) else {
        return false;
    };
    let dest = bind::dispatch_url(source, start, index);
    guard::guarded(&source[start..index], dest.as_deref())
}

/// Smallest function span strictly containing `index`.
fn innermost_span(spans: &[(usize, usize)], index: usize) -> Option<(usize, usize)> {
    spans
        .iter()
        .copied()
        .filter(|(span_start, end)| *span_start < index && index < *end)
        .min_by_key(|(span_start, end)| end - span_start)
}

/// `.send(` / `::send(` / `.execute(` / `::execute(`, optional turbofish.
fn dispatch_len(rest: &str) -> Option<usize> {
    const HEADS: &[&str] = &["::execute", "::send", ".execute", ".send"];
    let head = HEADS.iter().copied().find(|head| rest.starts_with(head))?;
    let after = &rest[head.len()..];
    let after = strip_turbofish(after).unwrap_or(after);
    after.starts_with('(').then_some(head.len())
}

pub(super) fn strip_turbofish(after: &str) -> Option<&str> {
    let after = after.strip_prefix("::")?.strip_prefix('<')?;
    let bytes = after.as_bytes();
    let (mut depth, mut brace) = (1i32, 0i32);
    let mut index = 0usize;
    while index < bytes.len() {
        // String and character literal regions are not code: a `'}'` or
        // `'<'` in a const-generic literal must not move the brace or angle
        // depth (Kimi council chunk04 P2).
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' => brace += 1,
            b'}' => brace = brace.saturating_sub(1),
            // `->` is a return type (`fn() -> R`) and `>` inside `{…}` is a
            // comparison (`{1 > 0}`); neither closes the turbofish.
            b'>' if brace == 0 && bytes.get(index.wrapping_sub(1)) != Some(&b'-') => {
                depth -= 1;
                if depth == 0 {
                    return Some(&after[index + 1..]);
                }
            }
            b'<' if brace == 0 => depth += 1,
            _ => {}
        }
        index += 1;
    }
    None
}

pub(super) fn after_paren(source: &str) -> Option<&str> {
    let bytes = source.as_bytes();
    let mut depth = 1i32;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&source[index + 1..]);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

pub(super) fn ident_at(bytes: &[u8], index: usize, ident: &[u8]) -> bool {
    let end = index + ident.len();
    end <= bytes.len()
        && &bytes[index..end] == ident
        && (index == 0 || !is_ident_byte(bytes[index - 1]))
        && (end == bytes.len() || !is_ident_byte(bytes[end]))
}

pub(super) fn is_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

pub(super) fn is_ident_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

#[path = "https_dispatch_tests.rs"]
#[cfg(test)]
mod dispatch_tests;

#[cfg(test)]
mod probes {
    use super::strip_turbofish;

    /// String and character literal regions inside a turbofish are not code:
    /// a `'}'` / `'<'` in a const-generic literal must not move the brace or
    /// angle depth, or the closer is never found and the alias call is
    /// dropped (Kimi council chunk04 P2).
    #[test]
    fn kimi_council_r4_literal_brace_does_not_desync_turbofish() {
        for (after, rest) in [
            ("::<'<'>(req)", "(req)"),
            ("::<'>'>(req)", "(req)"),
            ("::<\"}>\">(req)", "(req)"),
            ("::<A, '}'>(req)", "(req)"),
            ("::<{'}'}>(req)", "(req)"),
        ] {
            assert_eq!(strip_turbofish(after).as_deref(), Some(rest), "{after}");
        }
        // Controls: comparisons and return arrows still do not close.
        assert_eq!(strip_turbofish("::<{1 > 0}>(req)").as_deref(), Some("(req)"));
        assert_eq!(strip_turbofish("::<fn() -> R>(req)").as_deref(), Some("(req)"));
        assert!(strip_turbofish("::<A").is_none());
    }
}
