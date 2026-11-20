//! One-element tuple patterns that bind a dispatch function item.
pub(super) fn tuple_binding_name(source: &str, head: usize) -> Option<String> {
    let path_start = super::alias::path_prefix_start(source, head);
    let (open, element) = tuple_open_and_index(source, path_start)?;
    let eq = super::peel::eq_before(source.as_bytes(), open)?;
    let tail = super::alias::statement_tail(&source[..eq]);
    let paren = tail.find('(')?;
    if !let_introduces_pattern(&tail[..paren]) {
        return None;
    }
    let inside = paren_inside(&tail[paren..])?;
    let elements = tuple_elements(inside);
    let elem = elements.get(element)?.trim();
    pattern_name(elem)
}

fn tuple_open_and_index(source: &str, path_start: usize) -> Option<(usize, usize)> {
    let bytes = source.as_bytes();
    // `((Path::send),)` — the inner paren is grouping. Peel it so the comma
    // walk starts inside the tuple paren that `=` introduces.
    let mut index = super::peel::peel_expr_prefix(bytes, path_start, true)?;
    if index == 0 {
        return None;
    }
    // `";"` and `';'` are not statement ends. Comments are not either.
    let code = super::peel::code_mask(bytes);
    let mut depth = 0i32;
    let mut commas = 0usize;
    while index > 0 {
        index -= 1;
        if !code[index] {
            continue;
        }
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

fn paren_inside(at_paren: &str) -> Option<&str> {
    let bytes = at_paren.strip_prefix('(')?.as_bytes();
    let mut depth = 1i32;
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&at_paren[1..index + 1]);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn tuple_elements(inside: &str) -> Vec<&str> {
    let bytes = inside.as_bytes();
    let (mut depth, mut index, mut start) = (0i32, 0usize, 0usize);
    let mut out = Vec::new();
    while index < bytes.len() {
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

fn pattern_name(elem: &str) -> Option<String> {
    let mut elem = elem.trim();
    if let Some(rest) = strip_kw(elem, "mut") {
        elem = rest;
    }
    if let Some(rest) = strip_kw(elem, "ref") {
        elem = rest;
        if let Some(rest) = strip_kw(elem, "mut") {
            elem = rest;
        }
    }
    let name: String = elem
        .chars()
        .take_while(|ch| super::is_ident_char(*ch))
        .collect();
    if name.is_empty() || name == "_" {
        return None;
    }
    let rest = elem[name.len()..].trim_start();
    (rest.is_empty() || rest.starts_with(':')).then_some(name)
}

fn strip_kw<'a>(source: &'a str, keyword: &str) -> Option<&'a str> {
    let rest = source.strip_prefix(keyword)?;
    rest.chars()
        .next()
        .is_none_or(|ch| !super::is_ident_char(ch))
        .then(|| rest.trim_start())
}

/// `let (name,)` or `}let (name,)` after a previous block. `mut` may sit between.
fn let_introduces_pattern(before_paren: &str) -> bool {
    let before = before_paren.trim_end();
    if ends_with_kw(before, "let") {
        return true;
    }
    let Some(rest) = before.strip_suffix("mut") else {
        return false;
    };
    if rest.chars().next_back().is_some_and(super::is_ident_char) {
        return false;
    }
    ends_with_kw(rest.trim_end(), "let")
}

#[cfg(test)]
mod probes {
    use super::super::super::sync_target_pact_https::credentialed_send_https_gaps;

    #[test]
    fn council_p1_string_semicolon_keeps_tuple_send_alias() {
        let hits = [
            r#"fn f() { let (a, dispatch) = (";".into(), Path::send); dispatch(request); }"#,
            r#"fn f() { let (a, dispatch) = (';', Path::send); dispatch(request); }"#,
            r#"fn f() { let (a, dispatch) = ("{".into(), Path::send); dispatch(request); }"#,
            r#"fn f() { let (a, dispatch) = ("=".into(), reqwest::RequestBuilder::send); dispatch(request); }"#,
        ];
        for sample in hits {
            assert_eq!(
                super::super::dispatch_alias_calls(sample).len(),
                1,
                "{sample}"
            );
        }
        let bare = r#"async fn f() { let (a, dispatch) = (";".into(), Path::send); dispatch(request).await?; }"#;
        assert_eq!(credentialed_send_https_gaps(bare), (1, 1), "{bare}");
        let guarded = r#"async fn f() { if parsed.scheme() != "https" { return Err("x".into()); } let (a, dispatch) = (";".into(), Path::send); dispatch(request).await?; }"#;
        assert_eq!(credentialed_send_https_gaps(guarded), (1, 0), "{guarded}");
        let other = r#"fn f() { let (a, dispatch) = (";".into(), other); dispatch(request); }"#;
        assert!(
            super::super::dispatch_alias_calls(other).is_empty(),
            "{other}"
        );
    }
}

pub(super) fn ends_with_kw(source: &str, keyword: &str) -> bool {
    source.strip_suffix(keyword).is_some_and(|rest| {
        rest.chars()
            .next_back()
            .is_none_or(|ch| !super::is_ident_char(ch))
    })
}
