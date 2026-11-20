//! Tuple patterns that bind a request to one builder element.
use super::super::sync_target_pact_norm::string_len;
use super::is_ident_char;

/// `let (request,) = (client.get(evil),)` binds `request` to that element.
/// `Some` means the name is a destructured binding. The URL may be empty when
/// the element is not a builder call: that still must not fall through to an
/// unresolved destination.
pub(super) fn destructured_url(
    prefix: &str,
    name_at: usize,
    name: &str,
) -> Option<(String, usize)> {
    let (open, close) = let_tuple_around(prefix, name_at)?;
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
        return None;
    }
    let end = super::bind::stmt_end(bytes, at + 1);
    let piece = descend_rhs(prefix[at + 1..end].trim(), &path);
    let url = super::bind::builder_url(piece).unwrap_or("").to_string();
    Some((url, end))
}

/// Outermost `let` tuple that contains `name_at`, including `((request,),)`.
fn let_tuple_around(source: &str, name_at: usize) -> Option<(usize, usize)> {
    let (mut open, _) = tuple_pattern_open(source, name_at)?;
    loop {
        let close = matching_close(source, open)?;
        if let_pattern_intro(&source[..open]) {
            return Some((open, close));
        }
        let (outer, _) = tuple_pattern_open(source, open)?;
        if outer >= open {
            return None;
        }
        open = outer;
    }
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
    source
        .strip_suffix(keyword)
        .is_some_and(|rest| rest.chars().next_back().is_none_or(|ch| !is_ident_char(ch)))
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
}
