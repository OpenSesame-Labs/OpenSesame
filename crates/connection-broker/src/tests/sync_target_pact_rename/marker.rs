//! Marker scan helpers.
use super::super::sync_target_pact_norm::string_len;

pub(super) fn find_marker(source: &str, marker: &str, mut hit: impl FnMut(usize) -> bool) -> bool {
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

pub(super) fn is_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}
pub(crate) fn is_ident_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}
