//! One-element tuple patterns that bind a dispatch function item.
pub(super) fn tuple_binding_name(source: &str, head: usize) -> Option<String> {
    let path_start = super::alias::path_prefix_start(source, head);
    let (open, element) = tuple_open_and_index(source, path_start)?;
    let eq = super::peel::eq_before(source.as_bytes(), open)?;
    let tail = super::alias::statement_tail(&source[..eq]);
    let paren = first_code_byte(tail, b'(')?;
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
    let bytes = at_paren.as_bytes();
    if bytes.first() != Some(&b'(') {
        return None;
    }
    let code = super::peel::code_mask(bytes);
    let mut depth = 0i32;
    let mut index = 0usize;
    while index < bytes.len() {
        if !code[index] {
            index += 1;
            continue;
        }
        match bytes[index] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&at_paren[1..index]);
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
    let code = super::peel::code_mask(bytes);
    let (mut depth, mut index, mut start) = (0i32, 0usize, 0usize);
    let mut out = Vec::new();
    while index < bytes.len() {
        if !code[index] {
            index += 1;
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

/// First `target` byte that is not inside a string or comment.
fn first_code_byte(source: &str, target: u8) -> Option<usize> {
    let bytes = source.as_bytes();
    let code = super::peel::code_mask(bytes);
    bytes
        .iter()
        .enumerate()
        .position(|(index, byte)| code[index] && *byte == target)
}

fn pattern_name(elem: &str) -> Option<String> {
    let mut elem = trim_code_ends(elem);
    if let Some(rest) = strip_kw(elem, "mut") {
        elem = trim_code_ends(rest);
    }
    if let Some(rest) = strip_kw(elem, "ref") {
        elem = trim_code_ends(rest);
        if let Some(rest) = strip_kw(elem, "mut") {
            elem = trim_code_ends(rest);
        }
    }
    let name: String = elem
        .chars()
        .take_while(|ch| super::is_ident_char(*ch))
        .collect();
    if name.is_empty() || name == "_" {
        return None;
    }
    let rest = trim_code_ends(elem[name.len()..].trim_start());
    (rest.is_empty() || rest.starts_with(':')).then_some(name)
}

fn strip_kw<'a>(source: &'a str, keyword: &str) -> Option<&'a str> {
    let rest = source.strip_prefix(keyword)?;
    rest.chars()
        .next()
        .is_none_or(|ch| !super::is_ident_char(ch))
        .then(|| rest.trim_start())
}

/// `let (name,)` or `let /* c */ mut (name,)`. Comments are not code.
fn let_introduces_pattern(before_paren: &str) -> bool {
    let before = trim_code_end(before_paren);
    if ends_with_kw(before, "let") {
        return true;
    }
    let Some(rest) = before.strip_suffix("mut") else {
        return false;
    };
    if rest.chars().next_back().is_some_and(super::is_ident_char) {
        return false;
    }
    ends_with_kw(trim_code_end(rest), "let")
}

fn trim_code_end(source: &str) -> &str {
    let (end, _) = code_ends(source);
    &source[..end]
}

fn trim_code_ends(source: &str) -> &str {
    let (end, start) = code_ends(source);
    &source[start..end]
}

/// `(end, start)` of the code span, skipping whitespace and comments at both ends.
fn code_ends(source: &str) -> (usize, usize) {
    let bytes = source.as_bytes();
    let code = super::peel::code_mask(bytes);
    let mut start = 0usize;
    let mut end = bytes.len();
    while start < end && (bytes[start].is_ascii_whitespace() || !code[start]) {
        start += 1;
    }
    while end > start && (bytes[end - 1].is_ascii_whitespace() || !code[end - 1]) {
        end -= 1;
    }
    (end, start)
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

    #[test]
    fn chunk01_comment_in_tuple_pattern_keeps_send_alias() {
        let hits = [
            "fn f() { let /* c */ (dispatch,) = (Path::send,); dispatch(request); }",
            "fn f() { let // c\n (dispatch,) = (Path::send,); dispatch(request); }",
            "fn f() { let /* c */ mut /* d */ (dispatch,) = (Path::send,); dispatch(request); }",
            "fn f() { let /* ( */ (dispatch,) = (Path::send,); dispatch(request); }",
            "fn f() { let (dispatch /* ) */,) = (Path::send,); dispatch(request); }",
            "fn f() { let (/* ) */ dispatch,) = (Path::send,); dispatch(request); }",
            "fn f() { let (/* , */ dispatch,) = (Path::send,); dispatch(request); }",
            "fn f() { if cond { a; } let /* c */ (dispatch,) = (Path::send,); dispatch(request); }",
        ];
        for sample in hits {
            assert_eq!(
                super::super::dispatch_alias_calls(sample).len(),
                1,
                "{sample}"
            );
        }
        let bare =
            "async fn f() { let /* c */ (dispatch,) = (Path::send,); dispatch(request).await?; }";
        assert_eq!(credentialed_send_https_gaps(bare), (1, 1), "{bare}");
        let guarded = "async fn f() { if parsed.scheme() != \"https\" { return Err(\"x\".into()); } let (dispatch /* ) */,) = (Path::send,); dispatch(request).await?; }";
        assert_eq!(credentialed_send_https_gaps(guarded), (1, 0), "{guarded}");
        let misses = [
            "fn f() { let /* c */ (n,) = (Path::send,); dispatch(request); }",
            "fn f() { let (/* ) */ n,) = (Path::send,); dispatch(request); }",
            "fn f() { let /* dispatch */ (n,) = (Path::send,); dispatch(request); }",
        ];
        for sample in misses {
            assert!(
                super::super::dispatch_alias_calls(sample).is_empty(),
                "{sample}"
            );
        }
    }
}

pub(super) fn ends_with_kw(source: &str, keyword: &str) -> bool {
    source.strip_suffix(keyword).is_some_and(|rest| {
        rest.chars()
            .next_back()
            .is_none_or(|ch| !super::is_ident_char(ch))
    })
}
