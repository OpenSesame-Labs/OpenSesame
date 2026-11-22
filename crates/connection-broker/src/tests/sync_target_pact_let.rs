//! `let` binding names for credentialed dispatch aliases.
//!
//! Named types may contain `::`. `let name::_` and a `_` binding are not aliases.

use super::sync_target_pact_norm::string_len;

/// `let name: Type = Path::send` when `=` is not the byte immediately before the path.
pub(crate) fn typed_let_name_before_path(source: &str, head: usize) -> Option<String> {
    let prefix = &source[..head];
    let eq = last_single_eq(prefix)?;
    let bind = prefix[..eq].trim_end();
    // Untyped `let name =` is handled only when `=` sits against the path.
    let name = let_binding_name(bind)?;
    ascription_colon(statement_tail(bind)).map(|_| name)
}

pub(crate) fn binding_name_before(source: &str) -> Option<String> {
    let eq = last_single_eq(source)?;
    let_binding_name(source[..eq].trim_end())
}

/// Name in `let [mut] name[: Type]`.
pub(crate) fn let_binding_name(lhs: &str) -> Option<String> {
    let tail = statement_tail(lhs);
    let name_region = if let Some(colon) = ascription_colon(tail) {
        let ty = tail[colon + 1..].trim_start();
        if ty.is_empty() || ty.starts_with(':') {
            return None;
        }
        tail[..colon].trim_end()
    } else {
        tail
    };
    let name = trailing_ident(name_region)?;
    if name == "_" {
        return None;
    }
    let mut before = name_region[..name_region.len() - name.len()].trim_end();
    if ends_with_kw(before, "mut") {
        before = before[..before.len() - 3].trim_end();
    }
    ends_with_kw(before, "let").then_some(name)
}

/// Text after the previous `;` or `{`, so an earlier `let` is not this binding.
fn statement_tail(lhs: &str) -> &str {
    let bytes = lhs.as_bytes();
    let mut depth = 0i32;
    let mut index = bytes.len();
    while index > 0 {
        index -= 1;
        match bytes[index] {
            b'>' if index > 0 && bytes[index - 1] == b'-' => {}
            b')' | b']' | b'>' => depth += 1,
            b'(' | b'[' | b'<' if depth > 0 => depth -= 1,
            b';' | b'{' if depth == 0 => return lhs[index + 1..].trim(),
            _ => {}
        }
    }
    lhs.trim()
}

/// Type-ascription colon on one `let` tail. `::` in a named type is not one.
fn ascription_colon(tail: &str) -> Option<usize> {
    let bytes = tail.as_bytes();
    let mut depth = 0i32;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'<' => depth += 1,
            b')' | b']' | b'>' if depth > 0 => depth -= 1,
            b':' if depth == 0 && bytes.get(index + 1) == Some(&b':') => index += 1,
            b':' if depth == 0 => return Some(index),
            _ => {}
        }
        index += 1;
    }
    None
}

fn ends_with_kw(source: &str, keyword: &str) -> bool {
    let Some(rest) = source.strip_suffix(keyword) else {
        return false;
    };
    if !rest.chars().next_back().is_none_or(|ch| !is_ident_char(ch)) {
        return false;
    }
    // `if let` / `while let` end in the keyword `let` but do not introduce a
    // `let` binding: the pattern's scope is the condition, so it must not
    // register a dispatch alias or URL binding (pattern.rs `ends_with_kw`,
    // sqlx_exec `cond_let_head`; Kimi council chunk04 P2).
    let rest = rest.trim_end();
    keyword != "let" || !(ends_with_kw(rest, "if") || ends_with_kw(rest, "while"))
}

/// Last assignment `=`. `==`, `!=`, `<=`, `>=`, and match `=>` are not assignments.
/// `=` inside a string or character literal is not one either.
fn last_single_eq(prefix: &str) -> Option<usize> {
    let bytes = prefix.as_bytes();
    let code = eq_code(bytes);
    let mut index = prefix.len();
    while index > 0 {
        index -= 1;
        if !code[index] || bytes[index] != b'=' {
            continue;
        }
        if matches!(bytes.get(index + 1), Some(b'=' | b'>')) {
            continue;
        }
        if matches!(
            index.checked_sub(1).and_then(|prev| bytes.get(prev)),
            Some(b'!' | b'=' | b'<' | b'>' | b'+' | b'-' | b'*' | b'/' | b'%' | b'&' | b'|' | b'^')
        ) {
            continue;
        }
        return Some(index);
    }
    None
}

fn eq_code(bytes: &[u8]) -> Vec<bool> {
    let mut code = vec![true; bytes.len()];
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            let end = (index + len).min(bytes.len());
            for slot in &mut code[index..end] {
                *slot = false;
            }
            index = end.max(index + 1);
        } else {
            index += 1;
        }
    }
    code
}

fn trailing_ident(source: &str) -> Option<String> {
    let mut start = source.len();
    for (index, ch) in source.char_indices().rev() {
        if !is_ident_char(ch) {
            break;
        }
        start = index;
    }
    let name = &source[start..];
    (!name.is_empty()).then(|| name.to_string())
}

fn is_ident_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

#[cfg(test)]
mod probes {
    use super::super::sync_target_pact_https::credentialed_send_https_gaps;
    use super::typed_let_name_before_path;

    #[test]
    fn p5_match_arrow_is_not_let_eq() {
        let source = "async fn f() { let dispatch: T = match { arm => Path::send }; dispatch(request).await?; }";
        let head = source.find("Path::send").expect("path");
        assert_eq!(
            typed_let_name_before_path(source, head).as_deref(),
            Some("dispatch"),
            "{source}"
        );
        assert_eq!(credentialed_send_https_gaps(source), (1, 1), "{source}");
        let compared = "let dispatch: T = if a >= b { Path::send };";
        let head = compared.find("Path::send").expect("path");
        assert_eq!(
            typed_let_name_before_path(compared, head).as_deref(),
            Some("dispatch")
        );
    }

    /// `if let` / `while let` end in the keyword `let` but bind only inside
    /// the condition, like `pattern.rs` and `sqlx_exec` already refuse: they
    /// must not register a dispatch alias (Kimi council chunk04 P2).
    #[test]
    fn kimi_council_r4_if_while_let_is_not_a_let_introducer() {
        for lhs in ["if let dispatch", "while let dispatch"] {
            assert_eq!(super::let_binding_name(lhs), None, "{lhs}");
        }
        for lhs in ["let dispatch", "let mut dispatch"] {
            assert_eq!(
                super::let_binding_name(lhs).as_deref(),
                Some("dispatch"),
                "{lhs}"
            );
        }
        // End to end: the `if let` pattern must not make the later call a
        // credentialed alias dispatch.
        let masked = "async fn f() { if let dispatch = Path::send { dispatch(request).await?; } }";
        assert_eq!(credentialed_send_https_gaps(masked), (0, 0), "{masked}");
    }
}
