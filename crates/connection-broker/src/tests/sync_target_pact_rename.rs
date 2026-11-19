//! `let` renames that still point at the credentialed sync response receiver.

use super::sync_target_pact_norm::{is_keyword_at, string_len};

const RESPONSE_RECEIVERS: &[&str] = &["response", "res", "upstream", "http_response", "body"];

/// `let name: Type = Path::send` bindings when `=` is not immediately before the path.
pub(crate) fn typed_let_name_before_path(source: &str, head: usize) -> Option<String> {
    let prefix = &source[..head];
    let eq = last_single_eq(prefix)?;
    let bind = prefix[..eq].trim_end();
    let colon = bind.rfind(':')?;
    if bind[colon + 1..].trim_start().starts_with(':') || bind[colon + 1..].contains("::") {
        return None;
    }
    let name = trailing_ident(bind[..colon].trim_end())?;
    let mut before = bind[..colon].trim_end();
    before = &before[..before.len() - name.len()].trim_end();
    let before = if ends_with_kw(before, "mut") {
        &before[..before.len() - 3].trim_end()
    } else {
        before
    };
    ends_with_kw(before, "let").then_some(name)
}

fn ends_with_kw(source: &str, keyword: &str) -> bool {
    source
        .strip_suffix(keyword)
        .is_some_and(|rest| rest.chars().next_back().is_none_or(|ch| !is_ident_char(ch)))
}

fn last_single_eq(prefix: &str) -> Option<usize> {
    let bytes = prefix.as_bytes();
    let mut index = prefix.len();
    while index > 0 {
        index -= 1;
        if bytes[index] != b'=' {
            continue;
        }
        if bytes.get(index + 1) == Some(&b'=') {
            continue;
        }
        if matches!(
            bytes.get(index.wrapping_sub(1)),
            Some(b'!' | b'=' | b'<' | b'>')
        ) {
            continue;
        }
        return Some(index);
    }
    None
}

pub(crate) fn tracks_response_receiver(source: &str, before: usize, name: String) -> bool {
    let mut current = name;
    for _ in 0..8 {
        if RESPONSE_RECEIVERS
            .iter()
            .any(|receiver| receiver == &current)
        {
            return true;
        }
        let Some(next) = let_bind_rhs(&source[..before], &current) else {
            return false;
        };
        current = next;
    }
    false
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
            if bytes.get(at) == Some(&b'=')
                && bytes.get(at + 1) != Some(&b'=')
                && !matches!(
                    bytes.get(at.wrapping_sub(1)),
                    Some(b'=' | b'!' | b'<' | b'>')
                )
            {
                at += 1;
                while at < bytes.len() && bytes[at].is_ascii_whitespace() {
                    at += 1;
                }
                let Some(rhs) = read_ident_at(prefix, at) else {
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
        for source in [
            "async fn f() { let dispatch: _ = reqwest::RequestBuilder::send; dispatch(r).await?; }",
            "async fn f() { let dispatch:_=reqwest::RequestBuilder::send; dispatch(r).await?; }",
        ] {
            assert_eq!(dispatch_alias_calls(source).len(), 1, "{source}");
        }
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
