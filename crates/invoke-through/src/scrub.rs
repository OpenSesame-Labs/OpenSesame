//! Reflection scrub for known representations of a credential.
//!
//! The broker places the token upstream and returns the upstream's answer.
//! An upstream that echoes what it was sent — a debug or echo route, an error
//! that quotes the rejected token, a webhook preview — would turn that answer
//! into an oracle: the caller could not read the credential from the broker,
//! but could read it back from the host the broker is allowed to reach. That
//! is the reflection attack every egress-substitution design shares (ADR 0150
//! §4). This layer reduces direct reflection rather than relying on each
//! provider, but cannot detect every reversible transform.
//!
//! What is matched: the raw token; the token under one layer of text
//! encoding however the encoder spelled each character (`dialect.rs`) —
//! percent-encoded in either hex case with any subset of bytes escaped and
//! `+` for a space, JSON-escaped with any mix of short and `\u` escapes, and
//! HTML-escaped with any mix of named, decimal and hex references; and its
//! base64 body, standard and URL-safe, at each of the three byte alignments
//! it can sit at inside a larger blob (`Basic base64(user:token)` puts it at
//! alignment 2). The base64 needle is the run of characters that depends on
//! token bytes alone, so it matches wherever the token was encoded, whatever
//! surrounded it. What is not matched: two layers of encoding at once, or any
//! other transform — a hash, a reversal, or an encryption. A reversal or an
//! encryption with a known key can reveal the credential, and a hash can be
//! guessed when a credential has low entropy. This scrub is defense in depth,
//! not a confidentiality boundary for untrusted response data.

mod dialect;

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine as _;
use bytes::Bytes;
use zeroize::Zeroizing;

/// What replaces a reflected credential.
pub(crate) const REDACTED: &[u8] = b"[redacted:credential]";

// Invalid UTF-8 bytes cannot occur in a string credential or its textual
// encodings. Original 0xff bytes are escaped as `ff fe` while matching, and a
// replacement is `ff fd`; the final pass reverses one and renders the other.
const SCRUB_SENTINEL: &[u8] = &[0xff, 0xfd];
const ESCAPED_FF: &[u8] = &[0xff, 0xfe];

/// Aligned interior base64 needles shorter than this are not searched for: a
/// short run of base64 characters matches ordinary text by chance. Exact
/// whole-value encodings remain covered at every length.
const MIN_ENCODED_NEEDLE: usize = 12;

/// Remove a credential and its supported text/base64 encodings from bytes
/// received from an upstream. This is the narrow response-sink API for
/// credentialed adapters that do not otherwise use [`crate::Invoker`].
///
/// The returned flag is true when any representation was found. Callers may
/// return the scrubbed bytes on an error path, but successful responses should
/// normally fail closed when it is set instead of treating an echo as data.
#[must_use]
pub fn scrub_credential_reflection(bytes: Bytes, credential: &str) -> (Bytes, bool) {
    Needles::new(credential).scrub(bytes)
}

/// Remove every supplied credential/secret representation from one response.
/// All matches use one opaque internal marker, so one short credential cannot
/// match the public redaction inserted for another credential.
#[must_use]
pub fn scrub_credential_reflections(bytes: Bytes, credentials: &[&str]) -> (Bytes, bool) {
    let needles: Vec<Needles> = credentials
        .iter()
        .map(|credential| Needles::new(credential))
        .collect();
    scrub_needles(bytes, &needles)
}

/// Every byte form of one credential the scrub looks for. Held zeroized: the
/// forms are the credential by another name.
pub(crate) struct Needles {
    /// The credential itself, which each text dialect matches a unit at a time.
    token: Zeroizing<String>,
    forms: Vec<Zeroizing<Vec<u8>>>,
}

impl Needles {
    pub(crate) fn new(token: &str) -> Self {
        let held = Zeroizing::new(token.to_owned());
        let mut forms: Vec<Zeroizing<Vec<u8>>> = Vec::new();
        if token.is_empty() {
            return Self { token: held, forms };
        }
        forms.push(Zeroizing::new(token.as_bytes().to_vec()));
        // Whole-value base64 is safe to match even for short credentials. The
        // aligned needles below deliberately require a longer run because
        // their edge groups are discarded and may sit inside arbitrary text.
        for encoded in [
            STANDARD.encode(token),
            STANDARD_NO_PAD.encode(token),
            URL_SAFE.encode(token),
            URL_SAFE_NO_PAD.encode(token),
        ] {
            let encoded = Zeroizing::new(encoded.into_bytes());
            if !forms
                .iter()
                .any(|known| known.as_slice() == encoded.as_slice())
            {
                forms.push(encoded);
            }
        }
        let encoded = (0..3).flat_map(|alignment| {
            [false, true]
                .into_iter()
                .filter_map(move |url_safe| aligned_base64(token.as_bytes(), alignment, url_safe))
        });
        for form in encoded {
            if !forms
                .iter()
                .any(|known| known.as_slice() == form.as_slice())
            {
                forms.push(form);
            }
        }
        // Longest first, so a form that contains another is replaced whole.
        forms.sort_by_key(|form| std::cmp::Reverse(form.len()));
        Self { token: held, forms }
    }

    /// `bytes` with every form of the credential replaced, and whether any was
    /// found. Returns the input untouched when nothing matched.
    pub(crate) fn scrub(&self, bytes: Bytes) -> (Bytes, bool) {
        scrub_needles(bytes, std::slice::from_ref(self))
    }
}

pub(crate) fn scrub_needles(bytes: Bytes, needles: &[Needles]) -> (Bytes, bool) {
    if needles.is_empty() {
        return (bytes, false);
    }
    // Do not expose REDACTED to a later matching pass: a short credential
    // such as `a` occurs inside the marker and would recursively expand it.
    let protected = protect_original_ff(&bytes);
    let source = protected.as_deref().unwrap_or(&bytes);
    let mut current: Option<Vec<u8>> = None;
    for needle in needles {
        for form in &needle.forms {
            let haystack = current.as_deref().unwrap_or(source);
            if let Some(replaced) = replace_all(haystack, form, SCRUB_SENTINEL) {
                current = Some(replaced);
            }
        }
        for each in dialect::ALL {
            let haystack = current.as_deref().unwrap_or(source);
            if let Some(replaced) = dialect::replace(each, haystack, &needle.token, SCRUB_SENTINEL)
            {
                current = Some(replaced);
            }
        }
    }
    match current {
        Some(scrubbed) => (Bytes::from(render_scrub_markers(&scrubbed)), true),
        None => (bytes, false),
    }
}

pub(crate) fn scrub_needles_str(needles: &[Needles], value: String) -> (String, bool) {
    let (scrubbed, hit) = scrub_needles(Bytes::from(value.clone()), needles);
    if !hit {
        return (value, false);
    }
    // REDACTED is ASCII and every replaced form was a byte run of valid
    // UTF-8 matched whole, so the result stays UTF-8; fall back to the
    // bare marker rather than trust that silently.
    let text = String::from_utf8(scrubbed.to_vec())
        .unwrap_or_else(|_| String::from_utf8_lossy(REDACTED).into_owned());
    (text, true)
}

/// The base64 characters that depend on `token` alone when it sits `alignment`
/// bytes into a 3-byte group. The leading group (shared with whatever precedes
/// the token) and the trailing partial group (shared with whatever follows) are
/// dropped. `None` when what remains is too short to search for safely.
fn aligned_base64(token: &[u8], alignment: usize, url_safe: bool) -> Option<Zeroizing<Vec<u8>>> {
    let mut padded = Zeroizing::new(vec![0u8; alignment]);
    padded.extend_from_slice(token);
    let encoded = Zeroizing::new(if url_safe {
        URL_SAFE_NO_PAD.encode(padded.as_slice())
    } else {
        STANDARD_NO_PAD.encode(padded.as_slice())
    });
    let skip = if alignment == 0 { 0 } else { 4 };
    let whole_groups = padded.len() / 3;
    let end = whole_groups * 4;
    if end <= skip || end - skip < MIN_ENCODED_NEEDLE {
        return None;
    }
    Some(Zeroizing::new(encoded.as_bytes()[skip..end].to_vec()))
}

fn protect_original_ff(bytes: &[u8]) -> Option<Vec<u8>> {
    bytes.contains(&0xff).then(|| {
        let mut protected = Vec::with_capacity(bytes.len());
        for byte in bytes {
            if *byte == 0xff {
                protected.extend_from_slice(ESCAPED_FF);
            } else {
                protected.push(*byte);
            }
        }
        protected
    })
}

fn render_scrub_markers(bytes: &[u8]) -> Vec<u8> {
    let mut rendered = Vec::with_capacity(bytes.len());
    let mut at = 0usize;
    while at < bytes.len() {
        match bytes.get(at..at + 2) {
            Some(pair) if pair == SCRUB_SENTINEL => {
                rendered.extend_from_slice(REDACTED);
                at += 2;
            }
            Some(pair) if pair == ESCAPED_FF => {
                rendered.push(0xff);
                at += 2;
            }
            _ => {
                rendered.push(bytes[at]);
                at += 1;
            }
        }
    }
    rendered
}

/// `haystack` with every non-overlapping `needle` replaced by `marker`, or
/// `None` when the needle does not occur.
fn replace_all(haystack: &[u8], needle: &[u8], marker: &[u8]) -> Option<Vec<u8>> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let mut out: Option<Vec<u8>> = None;
    let mut copied = 0;
    let mut at = 0;
    while at + needle.len() <= haystack.len() {
        if &haystack[at..at + needle.len()] == needle {
            let buf = out.get_or_insert_with(|| Vec::with_capacity(haystack.len()));
            buf.extend_from_slice(&haystack[copied..at]);
            buf.extend_from_slice(marker);
            at += needle.len();
            copied = at;
        } else {
            at += 1;
        }
    }
    let mut buf = out?;
    buf.extend_from_slice(&haystack[copied..]);
    Some(buf)
}

#[cfg(test)]
#[path = "scrub_dialect_tests.rs"]
mod dialect_tests;

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "ghs_16C7e42F292c6912E7710c838347Ae178B4a";

    fn scrubbed(input: &str) -> (String, bool) {
        let (out, hit) = Needles::new(TOKEN).scrub(Bytes::from(input.to_string()));
        (String::from_utf8(out.to_vec()).unwrap(), hit)
    }

    #[test]
    fn raw_token_is_replaced_everywhere() {
        let (out, hit) = scrubbed(&format!("a {TOKEN} b {TOKEN}"));
        assert!(hit);
        assert_eq!(out, "a [redacted:credential] b [redacted:credential]");
    }

    #[test]
    fn base64_at_every_alignment_and_both_alphabets_is_replaced() {
        for prefix in ["", "x", "x:", "user:"] {
            let blob = format!("{prefix}{TOKEN}\n");
            for encoded in [
                base64::engine::general_purpose::STANDARD.encode(&blob),
                base64::engine::general_purpose::URL_SAFE.encode(&blob),
            ] {
                let (out, hit) = scrubbed(&format!("Basic {encoded}"));
                assert!(hit, "prefix {prefix:?}: {encoded}");
                // Nothing long enough to rebuild the token survives: at most
                // the edge groups shared with the prefix and suffix remain.
                let kept = out
                    .trim_start_matches("Basic ")
                    .replace("[redacted:credential]", "");
                assert!(kept.len() <= 12, "prefix {prefix:?}: kept {kept}");
            }
        }
    }

    #[test]
    fn a_short_whole_value_base64_echo_is_replaced() {
        let (out, hit) = Needles::new("a").scrub(Bytes::from_static(b"echo=YQ=="));
        assert!(hit);
        assert_eq!(&out[..], b"echo=[redacted:credential]");
    }

    #[test]
    fn binary_bytes_that_resemble_internal_markers_are_preserved() {
        let input = Bytes::from_static(&[0xff, b'a', 0xff, 0xfd, 0xff, 0xfe]);
        let (out, hit) = Needles::new("a").scrub(input);
        assert!(hit);
        let mut expected = vec![0xff];
        expected.extend_from_slice(REDACTED);
        expected.extend_from_slice(&[0xff, 0xfd, 0xff, 0xfe]);
        assert_eq!(&out[..], expected.as_slice());
    }

    #[test]
    fn multiple_credentials_share_one_marker_safe_pass() {
        let (out, hit) =
            scrub_credential_reflections(Bytes::from_static(b"token-one a"), &["token-one", "a"]);
        assert!(hit);
        assert_eq!(&out[..], b"[redacted:credential] [redacted:credential]");
    }

    #[test]
    fn percent_encoded_token_is_replaced() {
        let needles = Needles::new("tok/with+reserved=chars&more");
        let (out, hit) = needles.scrub(Bytes::from_static(
            b"?t=tok%2Fwith%2Breserved%3Dchars%26more",
        ));
        assert!(hit);
        assert_eq!(&out[..], b"?t=[redacted:credential]");
    }

    #[test]
    fn json_unicode_escapes_for_an_astral_character_are_replaced() {
        let needles = Needles::new("tok-🔑-secret");
        let (out, hit) =
            needles.scrub(Bytes::from_static(br#"{"echo":"tok-\uD83D\uDD11-secret"}"#));
        assert!(hit);
        assert_eq!(&out[..], br#"{"echo":"[redacted:credential]"}"#);
    }

    #[test]
    fn unrelated_bytes_pass_through_untouched() {
        let input = Bytes::from_static(b"{\"zen\":\"Design for failure.\"}");
        let (out, hit) = Needles::new(TOKEN).scrub(input.clone());
        assert!(!hit);
        assert_eq!(out, input);
    }

    #[test]
    fn an_empty_token_matches_nothing() {
        let (out, hit) = Needles::new("").scrub(Bytes::from_static(b"anything"));
        assert!(!hit);
        assert_eq!(&out[..], b"anything");
    }

    #[test]
    fn header_values_are_scrubbed_as_text() {
        let needles = Needles::new(TOKEN);
        let (out, hit) = scrub_needles_str(std::slice::from_ref(&needles), format!("req {TOKEN}"));
        assert!(hit);
        assert_eq!(out, "req [redacted:credential]");
    }
}
