//! `let` renames that still point at the credentialed sync response receiver.

use super::sync_target_pact_norm::{is_keyword_at, string_len};

const RESPONSE_RECEIVERS: &[&str] = &["response", "res", "upstream", "http_response", "body"];

pub(crate) fn tracks_response_receiver(source: &str, before: usize, name: String) -> bool {
    let mut current = name;
    let prefix = &source[..before];
    for _ in 0..8 {
        if is_response_name(&current) {
            return true;
        }
        if let Some(next) = let_bind_rhs(prefix, &current) {
            current = next;
            continue;
        }
        return param_is_response(prefix, &current);
    }
    false
}

fn is_response_name(name: &str) -> bool {
    RESPONSE_RECEIVERS.iter().any(|receiver| receiver == &name)
}

/// `Into::into(response)`, `Body::from::<T>(response)`, and `<Type as Trait>::from`.
pub(crate) fn ufcs_response_move(scanned: &str) -> bool {
    ["::into", "::from"]
        .into_iter()
        .any(|marker| ufcs_marker(scanned, marker))
}

fn ufcs_marker(source: &str, marker: &str) -> bool {
    find_marker(source, marker, |index| ufcs_at(source, index, marker.len()))
}

fn ufcs_at(source: &str, index: usize, len: usize) -> bool {
    let after = &source[index + len..];
    if after.chars().next().is_some_and(is_ident_char) {
        return false;
    }
    let peeled = strip_turbofish(after);
    let at = index + len + after.len() - peeled.len();
    if peeled.starts_with('(') {
        return args_track_response(source, at);
    }
    item_tail(peeled) && ufcs_type_is_response(&source[..index])
}

fn item_tail(after: &str) -> bool {
    let after = after.trim_start();
    matches!(
        after.chars().next(),
        None | Some(';' | ')' | ',' | ']' | '}')
    ) || after.starts_with("as ")
        || after == "as"
}

pub(crate) fn ufcs_type_is_response(prefix: &str) -> bool {
    if ends_ident(prefix, "Response") {
        return true;
    }
    let bytes = prefix.as_bytes();
    if bytes.last() != Some(&b'>') {
        return false;
    }
    let mut depth = 0i32;
    let mut index = bytes.len();
    while index > 0 {
        index -= 1;
        match bytes[index] {
            b'>' => depth += 1,
            b'<' => {
                depth -= 1;
                if depth == 0 {
                    return angle_inner_is_response(&prefix[index + 1..prefix.len() - 1]);
                }
            }
            _ => {}
        }
    }
    false
}

fn angle_inner_is_response(inner: &str) -> bool {
    if inner.contains(" as ") {
        return has_word(inner, "Response") || has_word(inner, "Body");
    }
    matches!(
        inner.rsplit("::").next().map(str::trim),
        Some("Response" | "Body")
    )
}

fn has_word(hay: &str, ident: &str) -> bool {
    hay.split(|ch: char| !is_ident_char(ch))
        .any(|part| part == ident)
}

fn ends_ident(prefix: &str, ident: &str) -> bool {
    let Some(rest) = prefix.strip_suffix(ident) else {
        return false;
    };
    rest.chars().next_back().is_none_or(|ch| !is_ident_char(ch))
}

pub(crate) fn strip_turbofish(after: &str) -> &str {
    let Some(rest) = after.strip_prefix("::<") else {
        return after;
    };
    let mut depth = 1i32;
    for (index, ch) in rest.char_indices() {
        match ch {
            '<' => depth += 1,
            '>' => {
                depth -= 1;
                if depth == 0 {
                    return &rest[index + ch.len_utf8()..];
                }
            }
            _ => {}
        }
    }
    after
}

fn find_marker(source: &str, marker: &str, mut hit: impl FnMut(usize) -> bool) -> bool {
    let bytes = source.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if source[index..].starts_with(marker) && hit(index) {
            return true;
        }
        index += 1;
    }
    false
}

pub(crate) fn args_track_response(source: &str, paren: usize) -> bool {
    let bytes = source.as_bytes();
    if bytes.get(paren) != Some(&b'(') {
        return false;
    }
    let mut depth = 1i32;
    let mut index = paren + 1;
    while index < bytes.len() && depth > 0 {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            byte if depth > 0 && is_ident_byte(byte) => {
                let start = index;
                while index < bytes.len() && is_ident_byte(bytes[index]) {
                    index += 1;
                }
                let name = &source[start..index];
                if tracks_response_receiver(source, start, name.to_string()) {
                    return true;
                }
                continue;
            }
            _ => {}
        }
        index += 1;
    }
    false
}

fn is_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// `.into()` / `.into::<T>()` whose receiver is a response, including `(response).into()`.
pub(crate) fn response_into_read(scanned: &str) -> bool {
    find_marker(scanned, ".into", |index| dot_into(scanned, index))
}

fn dot_into(scanned: &str, index: usize) -> bool {
    let after = &scanned[index + ".into".len()..];
    !after.chars().next().is_some_and(is_ident_char)
        && strip_turbofish(after).starts_with('(')
        && method_receiver_is_response(scanned, index)
}

pub(crate) fn method_receiver_is_response(source: &str, dot: usize) -> bool {
    let name = receiver_before(source, dot);
    !name.is_empty() && tracks_response_receiver(source, dot, name)
}

fn receiver_before(source: &str, dot: usize) -> String {
    let prefix = source[..dot].trim_end();
    if prefix.ends_with(')') {
        if let Some(name) = paren_group_ident(prefix) {
            return name;
        }
    }
    trailing_ident(prefix).unwrap_or_default()
}

fn paren_group_ident(prefix: &str) -> Option<String> {
    let open = matching_open(prefix, prefix.len() - 1)?;
    if open > 0 {
        let prev = prefix[..open].trim_end();
        if prev.ends_with(|ch: char| is_ident_char(ch) || ch == '.') {
            return None;
        }
    }
    plain_name(&prefix[open + 1..prefix.len() - 1])
}

fn let_bind_rhs(prefix: &str, name: &str) -> Option<String> {
    let bytes = prefix.as_bytes();
    let mut index = 0usize;
    let mut found = None;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if is_keyword_at(bytes, index, b"let") {
            if let Some(rhs) = let_named_rhs(prefix, bytes, index, name) {
                found = Some(rhs);
            }
        } else if is_keyword_at(bytes, index, name.as_bytes()) {
            if let Some(rhs) = assign_rhs(prefix, bytes, index + name.len()) {
                found = Some(rhs);
            }
        }
        index += 1;
    }
    found
}

fn let_named_rhs(prefix: &str, bytes: &[u8], index: usize, name: &str) -> Option<String> {
    let mut at = skip_ws(bytes, index + 3);
    if is_keyword_at(bytes, at, b"mut") {
        at = skip_ws(bytes, at + 3);
    }
    let bind = read_ident_at(prefix, at)?;
    at = skip_ws(bytes, at + bind.len());
    if bytes.get(at) == Some(&b':') && bytes.get(at + 1) != Some(&b':') {
        at = skip_ws(bytes, skip_type(bytes, at + 1));
    }
    if !is_single_eq(bytes, at) || bind != name {
        return None;
    }
    rhs_ident(prefix, skip_ws(bytes, at + 1))
}

fn assign_rhs(prefix: &str, bytes: &[u8], at: usize) -> Option<String> {
    let at = skip_ws(bytes, at);
    if !is_single_eq(bytes, at) {
        return None;
    }
    rhs_ident(prefix, skip_ws(bytes, at + 1))
}

fn skip_ws(bytes: &[u8], mut at: usize) -> usize {
    while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
        at += 1;
    }
    at
}

fn param_is_response(prefix: &str, name: &str) -> bool {
    let bytes = prefix.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if typed_param_is_response(prefix, bytes, index, name) {
            return true;
        }
        index += 1;
    }
    false
}

fn typed_param_is_response(prefix: &str, bytes: &[u8], index: usize, name: &str) -> bool {
    if !is_keyword_at(bytes, index, name.as_bytes()) || !param_slot(prefix, index) {
        return false;
    }
    let at = skip_ws(bytes, index + name.len());
    if bytes.get(at) != Some(&b':') || bytes.get(at + 1) == Some(&b':') {
        return false;
    }
    let end = skip_type(bytes, at + 1);
    type_is_response(&prefix[at + 1..end])
}

fn param_slot(source: &str, name_at: usize) -> bool {
    let before = source[..name_at].trim_end();
    ends_param(before) || mut_param(before)
}

fn ends_param(before: &str) -> bool {
    matches!(before.chars().next_back(), Some('(' | ',' | '|'))
}

fn mut_param(before: &str) -> bool {
    let Some(rest) = before.strip_suffix("mut") else {
        return false;
    };
    !rest.chars().next_back().is_some_and(is_ident_char) && ends_param(rest.trim_end())
}

fn type_is_response(ty: &str) -> bool {
    let mut ty = ty.trim();
    loop {
        if let Some(rest) = ty.strip_prefix('&') {
            ty = strip_mut_kw(rest.trim_start());
            continue;
        }
        if ty.starts_with('(') {
            let next = unwrap_parens(ty);
            if next.len() == ty.len() {
                break;
            }
            ty = next.trim();
            continue;
        }
        break;
    }
    trailing_ident(strip_generics(ty.trim())).as_deref() == Some("Response")
}

fn strip_generics(ty: &str) -> &str {
    let bytes = ty.as_bytes();
    if bytes.last() != Some(&b'>') {
        return ty;
    }
    let mut depth = 0i32;
    let mut index = bytes.len();
    while index > 0 {
        index -= 1;
        match bytes[index] {
            b'>' => depth += 1,
            b'<' => {
                depth -= 1;
                if depth == 0 {
                    return ty[..index].trim_end();
                }
            }
            _ => {}
        }
    }
    ty
}

fn strip_mut_kw(ty: &str) -> &str {
    if let Some(rest) = ty.strip_prefix("mut") {
        if rest.chars().next().is_none_or(|ch| !is_ident_char(ch)) {
            return rest.trim_start();
        }
    }
    ty
}

fn rhs_ident(source: &str, at: usize) -> Option<String> {
    let expr = strip_ref(unwrap_value(source.get(at..)?.trim_start()));
    read_ident_at(expr, 0)
}

pub(crate) fn plain_name(expr: &str) -> Option<String> {
    let expr = strip_ref(unwrap_value(expr.trim()));
    let name = read_ident_at(expr, 0)?;
    expr[name.len()..].trim().is_empty().then_some(name)
}

fn unwrap_value(expr: &str) -> &str {
    let mut expr = expr.trim();
    for _ in 0..4 {
        let next = peel_block(unwrap_parens(expr)).trim();
        if next.len() == expr.len() {
            break;
        }
        expr = next;
    }
    expr
}

fn peel_block(expr: &str) -> &str {
    if !expr.starts_with('{') {
        return expr;
    }
    let Some(close) = match_delim(expr, b'{', b'}') else {
        return expr;
    };
    let after = expr[close + 1..].trim_start();
    if !(after.is_empty() || matches!(after.chars().next(), Some(';' | '.' | ')' | ',' | ']'))) {
        return expr;
    }
    stmt_tail(&expr[1..close])
}

fn stmt_tail(inner: &str) -> &str {
    let bytes = inner.as_bytes();
    let (mut depth, mut index, mut semi) = (0i32, 0usize, 0usize);
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' | b'(' | b'[' => depth += 1,
            b'}' | b')' | b']' if depth > 0 => depth -= 1,
            b';' if depth == 0 => semi = index + 1,
            _ => {}
        }
        index += 1;
    }
    inner[semi..].trim()
}

fn strip_ref(expr: &str) -> &str {
    let mut expr = expr.trim_start();
    for _ in 0..4 {
        if let Some(rest) = expr.strip_prefix("&mut") {
            if rest.chars().next().is_none_or(|ch| !is_ident_char(ch)) {
                expr = rest.trim_start();
                continue;
            }
        }
        if let Some(rest) = expr.strip_prefix('&') {
            expr = rest.trim_start();
            continue;
        }
        break;
    }
    expr
}

fn unwrap_parens(expr: &str) -> &str {
    let mut expr = expr.trim();
    while expr.starts_with('(') {
        let Some(close) = match_delim(expr, b'(', b')') else {
            break;
        };
        let after = expr[close + 1..].trim_start();
        if !(after.is_empty() || matches!(after.chars().next(), Some(';' | '.' | ')'))) {
            break;
        }
        expr = expr[1..close].trim();
    }
    expr
}

fn match_delim(expr: &str, open_b: u8, close_b: u8) -> Option<usize> {
    let bytes = expr.as_bytes();
    if bytes.first() != Some(&open_b) {
        return None;
    }
    let (mut depth, mut index) = (0i32, 0usize);
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
                return Some(index);
            }
        }
        index += 1;
    }
    None
}

fn matching_open(source: &str, close: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut depth = 0i32;
    let mut index = close;
    loop {
        match bytes.get(index)? {
            b')' => depth += 1,
            b'(' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
        if index == 0 {
            return None;
        }
        index -= 1;
    }
}

fn is_single_eq(bytes: &[u8], index: usize) -> bool {
    bytes.get(index) == Some(&b'=')
        && !matches!(bytes.get(index + 1), Some(b'=' | b'>'))
        && !matches!(
            index.checked_sub(1).and_then(|prev| bytes.get(prev)),
            Some(b'=' | b'!' | b'<' | b'>')
        )
}

fn skip_type(bytes: &[u8], start: usize) -> usize {
    let mut depth = 0i32;
    let mut index = start;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'<' => depth += 1,
            b')' | b']' | b'>' if depth > 0 => depth -= 1,
            b',' | b')' | b'{' | b'=' | b'|' if depth == 0 => return index,
            b'-' if depth == 0 && bytes.get(index + 1) == Some(&b'>') => return index,
            _ => {}
        }
        index += 1;
    }
    index
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

fn read_ident_at(source: &str, at: usize) -> Option<String> {
    let rest = source.get(at..)?;
    let name: String = rest.chars().take_while(|ch| is_ident_char(*ch)).collect();
    (!name.is_empty()).then_some(name)
}

fn is_ident_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

#[cfg(test)]
mod tests {
    use super::super::sync_target_pact_chain::{dispatch_alias_calls, response_chain_consumer};

    #[test]
    fn typed_dispatch_aliases_register() {
        let source =
            "async fn f() { let dispatch: _ = reqwest::RequestBuilder::send; dispatch(r).await?; }";
        assert_eq!(dispatch_alias_calls(source).len(), 1);
    }

    #[test]
    fn renamed_bindings_still_chain_consume() {
        for sample in [
            "let reply = response; reply.count().await",
            "let mut reply = response; let again = reply; again.collect()",
        ] {
            assert!(
                response_chain_consumer(sample),
                "renamed response binding must consume: {sample}"
            );
        }
    }

    #[test]
    fn p5_rename_forms_are_body_reads() {
        use super::super::sync_target_pact_scan::response_body_reads;
        let hits = [
            "fn steal(mut reply: reqwest::Response) { reply.into() }",
            "fn steal(mut reply: &mut reqwest::Response) { reply.into() }",
            "fn steal(mut reply: http::Response<Body>) { reply.into() }",
            "|mut reply: Response| reply.into()",
            "let reply = { response }; reply.into()",
            "let reply = { let _ = \";\"; response }; reply.into()",
            "let mut reply = other; reply = response; reply.into()",
            "let mut reply = other; reply = { response }; reply.into()",
            "let reply = response; reply.into::<reqwest::Body>()",
            "(response).into::<Body>()",
            "Body::from::<Vec<u8>>(response)",
            "<reqwest::Response as Into<Body>>::from(response)",
            "let f = <Response as Into<Body>>::from;",
            "let reply = response; dbg!(reply)",
            "let reply = response; dbg!((reply))",
            "let reply = response; format!(\"{:?}\", reply)",
            "let reply = response; format!(\"{:?}\", { reply })",
            "fn log(mut reply: reqwest::Response) { dbg!(reply); }",
            "fn log(mut reply: reqwest::Response) { format!(\"{reply:?}\"); }",
            "let mut reply = other; reply = response; format!(\"{:?}\", reply)",
        ];
        for sample in hits {
            assert!(
                !response_body_reads(sample).is_empty(),
                "renamed response must stay discarded: {sample}"
            );
        }
        let misses = [
            "fn steal(mut reply: Status) { reply.into() }",
            "let reply = { status }; reply.into()",
            "let mut reply = response; reply = status; reply.into()",
            "rows.into::<Vec<_>>()",
            "\"https\".into::<String>()",
            "<SyncTargetView as From<Row>>::from(row)",
            "let f = <Row as From<Status>>::from;",
            "dbg!(status)",
            "let reply = status; format!(\"{:?}\", reply)",
            "let reply = status; format!(\"{:?}\", { reply })",
            "SyncTargetView::from(row)",
        ];
        for sample in misses {
            assert!(
                response_body_reads(sample).is_empty(),
                "unrelated rename is not a body read: {sample}"
            );
        }
    }
}
