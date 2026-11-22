//! UFCS moves and `.into()` on response receivers.
use super::super::sync_target_pact_norm::string_len;
use super::marker::is_ident_char;

/// `Into::into(response)`, `Body::from::<T>(response)`, and `<Type as Trait>::from`.
pub(crate) fn ufcs_response_move(scanned: &str) -> bool {
    ["::into", "::from"]
        .into_iter()
        .any(|marker| ufcs_marker(scanned, marker))
}

fn ufcs_marker(source: &str, marker: &str) -> bool {
    super::marker::find_marker(source, marker, |index| ufcs_at(source, index, marker.len()))
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
    if let Some((self_ty, _)) = inner.split_once(" as ") {
        return matches!(
            self_ty.rsplit("::").next().map(str::trim),
            Some("Response" | "Body")
        );
    }
    matches!(
        inner.rsplit("::").next().map(str::trim),
        Some("Response" | "Body")
    )
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
            byte if depth > 0 && super::marker::is_ident_byte(byte) => {
                let start = index;
                while index < bytes.len() && super::marker::is_ident_byte(bytes[index]) {
                    index += 1;
                }
                let name = &source[start..index];
                if super::tracks_response_receiver(source, start, name.to_string()) {
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

/// `.into()` / `.try_into()` and fallible UFCS moves on a response receiver.
pub(crate) fn response_into_read(scanned: &str) -> bool {
    super::marker::find_marker(scanned, ".into", |index| dot_into(scanned, index))
        || super::marker::find_marker(scanned, ".try_into", |index| dot_try_into(scanned, index))
        || super::marker::find_marker(scanned, "::try_from", |index| {
            ufcs_at(scanned, index, "::try_from".len())
        })
        || super::marker::find_marker(scanned, "::try_into", |index| {
            ufcs_at(scanned, index, "::try_into".len())
        })
}

fn dot_try_into(scanned: &str, index: usize) -> bool {
    let after = &scanned[index + ".try_into".len()..];
    !after.chars().next().is_some_and(is_ident_char)
        && strip_turbofish(after).starts_with('(')
        && method_receiver_is_response(scanned, index)
}

fn dot_into(scanned: &str, index: usize) -> bool {
    let after = &scanned[index + ".into".len()..];
    !after.chars().next().is_some_and(is_ident_char)
        && strip_turbofish(after).starts_with('(')
        && method_receiver_is_response(scanned, index)
}

pub(crate) fn method_receiver_is_response(source: &str, dot: usize) -> bool {
    let name = super::peel::receiver_before(source, dot);
    !name.is_empty() && super::tracks_response_receiver(source, dot, name)
}
