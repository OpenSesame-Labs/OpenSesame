//! `let` renames that still point at the credentialed sync response receiver.

use super::sync_target_pact_norm::{is_keyword_at, string_len};

const RESPONSE_RECEIVERS: &[&str] = &["response", "res", "upstream", "http_response", "body"];

pub(crate) fn tracks_response_receiver(source: &str, before: usize, name: String) -> bool {
    let mut current = name;
    for _ in 0..8 {
        if is_response_name(&current) || param_is_response(&source[..before], &current) {
            return true;
        }
        let Some(next) = let_bind_rhs(&source[..before], &current) else {
            return false;
        };
        current = next;
    }
    false
}

fn is_response_name(name: &str) -> bool {
    RESPONSE_RECEIVERS.iter().any(|receiver| receiver == &name)
}

/// `.into()` whose receiver is a response, including `(response).into()`.
pub(crate) fn response_into_read(scanned: &str) -> bool {
    let mut offset = 0usize;
    while let Some(rel) = scanned[offset..].find(".into()") {
        let index = offset + rel;
        let name = receiver_before(scanned, index);
        if !name.is_empty() && tracks_response_receiver(scanned, index, name) {
            return true;
        }
        offset = index + ".into()".len();
    }
    false
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
            let mut at = index + 3;
            while at < bytes.len() && bytes[at].is_ascii_whitespace() {
                at += 1;
            }
            if is_keyword_at(bytes, at, b"mut") {
                at += 3;
                while at < bytes.len() && bytes[at].is_ascii_whitespace() {
                    at += 1;
                }
            }
            let bind = read_ident_at(prefix, at)?;
            at += bind.len();
            while at < bytes.len() && bytes[at].is_ascii_whitespace() {
                at += 1;
            }
            if bytes.get(at) == Some(&b':') && bytes.get(at + 1) != Some(&b':') {
                at = skip_type(bytes, at + 1);
                while at < bytes.len() && bytes[at].is_ascii_whitespace() {
                    at += 1;
                }
            }
            if is_single_eq(bytes, at) {
                at += 1;
                while at < bytes.len() && bytes[at].is_ascii_whitespace() {
                    at += 1;
                }
                let Some(rhs) = rhs_ident(prefix, at) else {
                    index = at;
                    continue;
                };
                if bind == name {
                    found = Some(rhs);
                }
            }
            index = at;
            continue;
        }
        index += 1;
    }
    found
}

fn param_is_response(prefix: &str, name: &str) -> bool {
    let bytes = prefix.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if is_keyword_at(bytes, index, name.as_bytes()) && param_slot(prefix, index) {
            let mut at = index + name.len();
            while at < bytes.len() && bytes[at].is_ascii_whitespace() {
                at += 1;
            }
            if bytes.get(at) == Some(&b':') && bytes.get(at + 1) != Some(&b':') {
                let end = skip_type(bytes, at + 1);
                if type_is_response(&prefix[at + 1..end]) {
                    return true;
                }
            }
        }
        index += 1;
    }
    false
}

fn param_slot(source: &str, name_at: usize) -> bool {
    let before = source[..name_at].trim_end();
    before.ends_with('(') || before.ends_with(',')
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
    trailing_ident(ty).as_deref() == Some("Response")
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
    let expr = strip_ref(unwrap_parens(source.get(at..)?.trim_start()));
    read_ident_at(expr, 0)
}

fn plain_name(expr: &str) -> Option<String> {
    let expr = strip_ref(unwrap_parens(expr.trim()));
    let name = read_ident_at(expr, 0)?;
    expr[name.len()..].trim().is_empty().then_some(name)
}

fn strip_ref(expr: &str) -> &str {
    let expr = expr.trim_start();
    if let Some(rest) = expr.strip_prefix("&mut") {
        if rest.chars().next().is_none_or(|ch| !is_ident_char(ch)) {
            return rest.trim_start();
        }
    }
    expr.strip_prefix('&').map(str::trim_start).unwrap_or(expr)
}

fn unwrap_parens(expr: &str) -> &str {
    let mut expr = expr.trim();
    while expr.starts_with('(') {
        let Some(close) = depth0_close(expr) else {
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

fn depth0_close(expr: &str) -> Option<usize> {
    let mut depth = 0i32;
    for (index, byte) in expr.bytes().enumerate() {
        match byte {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
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
        && bytes.get(index + 1) != Some(&b'=')
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
            b',' | b')' | b'{' | b'=' if depth == 0 => return index,
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
}
