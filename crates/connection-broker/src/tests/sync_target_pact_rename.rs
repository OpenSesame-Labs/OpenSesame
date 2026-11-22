//! `let` renames that still point at the credentialed sync response receiver.

use super::sync_target_pact_norm::{is_keyword_at, string_len};

const RESPONSE_RECEIVERS: &[&str] = &["response", "res", "upstream", "http_response", "body"];

pub(crate) fn tracks_response_receiver(source: &str, before: usize, name: String) -> bool {
    let mut current = name;
    for _ in 0..8 {
        if RESPONSE_RECEIVERS.iter().any(|receiver| receiver == &current) {
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
            let bind = read_ident(prefix, at)?;
            at += bind.len();
            while at < bytes.len() && bytes[at].is_ascii_whitespace() {
                at += 1;
            }
            if bytes.get(at) == Some(&b'=')
                && bytes.get(at + 1) != Some(&b'=')
                && !matches!(bytes.get(at.wrapping_sub(1)), Some(b'=' | b'!' | b'<' | b'>'))
            {
                at += 1;
                while at < bytes.len() && bytes[at].is_ascii_whitespace() {
                    at += 1;
                }
                let rhs = read_ident(prefix, at)?;
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

fn read_ident(source: &str, at: usize) -> Option<String> {
    let rest = source.get(at..)?;
    let name: String = rest.chars().take_while(|ch| is_ident_char(*ch)).collect();
    (!name.is_empty()).then_some(name)
}

fn is_ident_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

#[cfg(test)]
mod tests {
    use super::super::sync_target_pact_chain::response_chain_consumer;

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