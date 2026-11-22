//! Tuple patterns that bind a request to one builder element.
use super::super::sync_target_pact_norm::{is_keyword_at, non_code_len, string_len};
use super::is_ident_char;

/// `let (request,) = (client.get(evil),)` binds `request` to that element,
/// and a statement-start reassignment `(request,) = (client.get(evil),)`
/// rebinds it. `Some` means the name is a destructured binding, with `true`
/// when a `let` introduced it and `false` for the assignment form. The URL
/// may be empty when the element is not a builder call: that still must not
/// fall through to an unresolved destination.
pub(super) fn destructured_url(
    prefix: &str,
    name_at: usize,
    name: &str,
) -> Option<(String, usize, bool)> {
    let (open, close, is_let) = tuple_around(prefix, name_at)?;
    let path = bind_path(&prefix[open + 1..close], name)?;
    let bytes = prefix.as_bytes();
    let mut at = close + 1;
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    if bytes.get(at) == Some(&b':') && bytes.get(at + 1) != Some(&b':') {
        at = super::bind::skip_ascription(bytes, at + 1);
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
    }
    if !super::bind::is_single_eq(bytes, at) {
        // A match arm (`match (client.get(evil),) { (request,) => … }`) binds
        // the scrutinee element, not a value from an `=` RHS. The scrutinee
        // is the expression between the `match` keyword and the match body's
        // opening brace (Kimi council chunk04 P2).
        if is_let || bytes.get(at) != Some(&b'=') || bytes.get(at + 1) != Some(&b'>') {
            return None;
        }
        let body = match_body_open(prefix, open)?;
        let scrutinee = scrutinee_span(prefix, body)?;
        let piece = descend_rhs(&prefix[scrutinee..body], &path);
        let url = super::bind::builder_url(piece).unwrap_or("").to_string();
        return Some((url, close + 1, false));
    }
    let end = super::bind::stmt_end(bytes, at + 1);
    let piece = descend_rhs(prefix[at + 1..end].trim(), &path);
    let url = super::bind::builder_url(piece).unwrap_or("").to_string();
    Some((url, end, is_let))
}

/// Most recent unclosed `{` before the arm pattern: the match body's open.
/// Earlier arms, guards, and scrutinee groups are balanced by then; the fn
/// body below the stack is not the top.
fn match_body_open(source: &str, before: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut stack: Vec<usize> = Vec::new();
    let mut index = 0usize;
    while index < before {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' => stack.push(index),
            b'}' => {
                stack.pop();
            }
            _ => {}
        }
        index += 1;
    }
    stack.pop()
}

/// End of the `match` keyword whose scrutinee feeds the arm: the last
/// `match` before the match body's open. Strings and comments are skipped;
/// earlier closed blocks cannot contribute a later keyword.
fn scrutinee_span(source: &str, body_open: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut index = 0usize;
    let mut match_at = None;
    while index < body_open {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if is_keyword_at(bytes, index, b"match") {
            match_at = Some(index);
        }
        index += 1;
    }
    match_at.map(|at| at + "match".len())
}

/// Outermost tuple pattern around `name_at`, including `((request,),)`, with
/// whether a `let` introduced it. A tuple at statement start with no `let` is
/// a reassignment: it rebinds the element like an assignment, not a
/// block-local shadow.
fn tuple_around(source: &str, name_at: usize) -> Option<(usize, usize, bool)> {
    let (mut open, _) = tuple_pattern_open(source, name_at)?;
    loop {
        let close = matching_close(source, open)?;
        if let_pattern_intro(&source[..open]) {
            return Some((open, close, true));
        }
        if statement_intro(&source[..open]) || arm_intro(&source[..open], source, close) {
            return Some((open, close, false));
        }
        let (outer, _) = tuple_pattern_open(source, open)?;
        if outer >= open {
            return None;
        }
        open = outer;
    }
}

/// `(request,) => …` match arm: the pattern sits at an arm boundary (`{` or
/// `,` before it — later arms follow an earlier arm's `}` and a comma) and
/// the arm arrow follows the close. A tuple assignment `(request,) = …`
/// never has `=>` after the pattern.
fn arm_intro(before_paren: &str, source: &str, close: usize) -> bool {
    let last = before_paren.trim_end().as_bytes().last();
    if !matches!(last, Some(b'{' | b',' | b'}' | b';')) {
        return false;
    }
    let bytes = source.as_bytes();
    let mut at = close + 1;
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    bytes.get(at) == Some(&b'=') && bytes.get(at + 1) == Some(&b'>')
}

/// The tuple opens a statement (`;`, `{`, or `}` right before it), the shape
/// of a destructuring assignment `(request,) = …`.
fn statement_intro(before_paren: &str) -> bool {
    let last = before_paren.trim_end().as_bytes().last();
    matches!(last, None | Some(b';' | b'{' | b'}'))
}

fn bind_path(inside: &str, name: &str) -> Option<Vec<usize>> {
    for (index, part) in tuple_parts(inside).into_iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if direct_binds(part, name) {
            return Some(vec![index]);
        }
        let Some(inner) = whole_tuple(part) else {
            continue;
        };
        let Some(mut rest) = bind_path(inner, name) else {
            continue;
        };
        rest.insert(0, index);
        return Some(rest);
    }
    None
}

fn descend_rhs<'a>(rhs: &'a str, path: &[usize]) -> &'a str {
    let mut piece = rhs.trim();
    for (depth, index) in path.iter().copied().enumerate() {
        let Some(inside) = rhs_tuple(piece) else {
            return if depth == 0 { piece } else { "" };
        };
        piece = tuple_parts(inside).get(index).copied().unwrap_or("").trim();
    }
    piece
}

fn rhs_tuple(rhs: &str) -> Option<&str> {
    if !rhs.starts_with('(') {
        return None;
    }
    super::bind::call_inside(rhs)
}

fn tuple_pattern_open(source: &str, name_at: usize) -> Option<(usize, usize)> {
    let bytes = source.as_bytes();
    if name_at == 0 {
        return None;
    }
    let mut index = name_at;
    let mut depth = 0i32;
    let mut commas = 0usize;
    while index > 0 {
        index -= 1;
        match bytes[index] {
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' | b'{' if depth > 0 => depth -= 1,
            b'(' if depth == 0 => return Some((index, commas)),
            b',' if depth == 0 => commas += 1,
            b'=' | b';' | b'{' if depth == 0 => return None,
            _ => {}
        }
    }
    None
}

fn matching_close(source: &str, open: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    if bytes.get(open) != Some(&b'(') {
        return None;
    }
    let mut depth = 0i32;
    let mut index = open;
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
                    return Some(index);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn let_pattern_intro(before_paren: &str) -> bool {
    let before = before_paren.trim_end();
    if ends_with_kw(before, "let") {
        return true;
    }
    let Some(rest) = before.strip_suffix("mut") else {
        return false;
    };
    if rest.chars().next_back().is_some_and(is_ident_char) {
        return false;
    }
    ends_with_kw(rest.trim_end(), "let")
}

fn ends_with_kw(source: &str, keyword: &str) -> bool {
    let Some(rest) = strip_suffix_kw(source, keyword) else {
        return false;
    };
    // `if let` / `while let` end in the keyword `let` but do not introduce a
    // `let` binding. Those patterns must not become URL bindings.
    if keyword == "let" && (ends_with_kw(rest, "if") || ends_with_kw(rest, "while")) {
        return false;
    }
    true
}

pub(super) fn whole_tuple(lhs: &str) -> Option<&str> {
    let inside = super::bind::call_inside(lhs)?;
    let consumed = 1 + inside.len() + 1;
    lhs.get(consumed..)
        .is_some_and(|rest| rest.trim().is_empty())
        .then_some(inside)
}

pub(super) fn tuple_parts(inside: &str) -> Vec<&str> {
    let bytes = inside.as_bytes();
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
                out.push(inside[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    out.push(inside[start..].trim());
    out
}

pub(super) fn pattern_binds(elem: &str, name: &str) -> bool {
    let elem = strip_binding_kw(elem.trim());
    if let Some(inside) = whole_tuple(elem) {
        return tuple_parts(inside)
            .iter()
            .any(|part| !part.is_empty() && pattern_binds(part, name));
    }
    direct_binds(elem, name)
}

fn direct_binds(elem: &str, name: &str) -> bool {
    let elem = strip_binding_kw(elem);
    let ident = super::bind::ident_prefix(elem);
    if ident != name {
        return false;
    }
    let rest = elem[ident.len()..].trim_start();
    rest.is_empty() || rest.starts_with(':')
}

fn strip_binding_kw(mut elem: &str) -> &str {
    for _ in 0..3 {
        let mut stripped = false;
        for kw in ["mut", "ref"] {
            if let Some(rest) = strip_prefix_kw(elem, kw) {
                elem = rest;
                stripped = true;
            }
        }
        if !stripped {
            break;
        }
    }
    elem
}

pub(super) fn strip_prefix_kw<'a>(source: &'a str, keyword: &str) -> Option<&'a str> {
    let rest = source.strip_prefix(keyword)?;
    rest.chars()
        .next()
        .is_none_or(|ch| !is_ident_char(ch))
        .then(|| rest.trim_start())
}

/// `keyword ` before `source`'s end: the suffix mirror of `strip_prefix_kw`,
/// trimmed for the next suffix check.
pub(super) fn strip_suffix_kw<'a>(source: &'a str, keyword: &str) -> Option<&'a str> {
    let rest = source.strip_suffix(keyword)?;
    rest.chars()
        .next_back()
        .is_none_or(|ch| !is_ident_char(ch))
        .then(|| rest.trim_end())
}

#[cfg(test)]
mod probes {
    use super::super::credentialed_send_https_gaps;

    #[test]
    fn p5_nested_tuple_request_binding() {
        let decoy = r#"async fn f() { if safe.scheme() != "https" { return Err("x".into()); } let ((request,),) = ((client.get(evil),),); request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(decoy), (1, 1), "{decoy}");
        let kept = r#"async fn f() { let ((request,),) = ((client.get(url),),); if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(kept), (1, 0), "{kept}");
    }

    #[test]
    fn chunk02_if_let_tuple_is_not_a_url_binding() {
        // `if let` / `while let` shadow only inside the condition. They must
        // not replace the outer `request` builder, or the later send looks
        // guarded by the pattern's URL.
        let masked = [
            r#"async fn f() { let request = client.get(evil); if url.scheme() != "https" { return Err("x".into()); } if let (request,) = (client.get(url),) { let _ = 1; } request.send().await?; }"#,
            r#"async fn f() { let request = client.get(evil); if url.scheme() != "https" { return Err("x".into()); } while let (request,) = (client.get(url),) { break; } request.send().await?; }"#,
            r#"async fn f() { let request = client.get(evil); if url.scheme() != "https" { return Err("x".into()); } if let mut (request,) = (client.get(url),) { let _ = 1; } request.send().await?; }"#,
        ];
        for sample in masked {
            assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
        }
        let kept = [
            r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } let (request,) = (client.get(url),); request.send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } let mut (request,) = (client.get(url),); request.send().await?; }"#,
        ];
        for sample in kept {
            assert_eq!(credentialed_send_https_gaps(sample), (1, 0), "{sample}");
        }
    }

    #[test]
    fn chunk02_tuple_reassignment_rebinds_builder_url() {
        // `(request,) = (…)` is not a `let`, but it does rebind the element.
        // Without it the stored URL stays `url`, and the post-guard send on
        // the rebuilt `evil` request still looks guarded.
        let decoy = [
            r#"async fn f() { let (request,) = (client.get(url),); if url.scheme() != "https" { return Err("x".into()); } (request,) = (client.get(evil),); request.send().await?; }"#,
            r#"async fn f() { let (request,) = (client.get(url),); (request,) = (client.get(evil),); if url.scheme() != "https" { return Err("x".into()); } request.send().await?; }"#,
        ];
        for sample in decoy {
            assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
        }
        let kept = [
            r#"async fn f() { let (request,) = (client.get(url),); if url.scheme() != "https" { return Err("x".into()); } (request,) = (client.get(url),); request.send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } let (request,) = (client.get(url),); request.send().await?; }"#,
        ];
        for sample in kept {
            assert_eq!(credentialed_send_https_gaps(sample), (1, 0), "{sample}");
        }
    }
}
