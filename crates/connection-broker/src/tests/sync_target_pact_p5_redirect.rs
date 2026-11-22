//! Redirect-policy contract for the credentialed egress client builders.
//!
//! Every `.redirect(` call in an egress client source must be handed
//! `Policy::none()`. The argument is parsed per call site: an unrelated
//! `Policy::none()` expression elsewhere in the file does not satisfy the
//! check, and neither does a comment or string that merely quotes the call.
use super::super::sync_target_pact_norm::{non_code_len, strip_noise};

#[test]
fn p5_redirect_policy_none_in_egress_clients() {
    assert!(
        egress_sources_disable_redirects(),
        "credentialed egress client must disable redirects"
    );
    let commented = "// .redirect(redirect::Policy::none())\nfn f() {}\n";
    assert!(!redirect_policy_none_in_code(commented));
    let quoted = "fn f() { let _ = \".redirect(redirect::Policy::none())\"; }\n";
    assert!(!redirect_policy_none_in_code(quoted));
    let unrelated = [
        "fn f() { client.redirect(redirect::Policy::limited(10)); }\nfn g() { let _ = Policy::none(); }\n",
        "fn f() { builder.redirect(Policy::none()); other.redirect(Policy::limited(1)); }\n",
        "fn f() { builder.redirect(wrap(Policy::none())); }\n",
    ];
    for sample in unrelated {
        assert!(!redirect_policy_none_in_code(sample), "{sample}");
    }
    let configured = [
        "fn f() { builder.redirect(reqwest::redirect::Policy::none()); }\n",
        "fn f() { builder.redirect(redirect::Policy::none()); }\n",
        "fn f() { builder.redirect(Policy::none()); }\n",
    ];
    for sample in configured {
        assert!(redirect_policy_none_in_code(sample), "{sample}");
    }
}

/// Structural check, exported for pact probes that assert one source disables
/// redirects without re-running the whole egress set.
pub(crate) fn code_disables_redirects(src: &str) -> bool {
    redirect_policy_none_in_code(src)
}

/// The shared broker client in `lib.rs` / `constructor.rs` and the pinned
/// egress client keep `redirect::Policy::none()`: each `.redirect(` argument
/// must be `Policy::none()`, not an unrelated marker in the same file
/// (Codex PRRT_kwDOTwzAKs65fDy4, PRRT_kwDOTwzAKs65wAMQ).
#[test]
fn codex_thread_egress_client_sources_disable_redirects() {
    for (name, src) in [
        ("lib.rs", include_str!("../lib.rs")),
        ("constructor.rs", include_str!("../constructor.rs")),
        ("egress_client.rs", include_str!("../egress_client.rs")),
    ] {
        assert!(
            code_disables_redirects(src),
            "{name} must disable redirects"
        );
    }
    let swapped = "fn f() { builder.redirect(redirect::Policy::limited(10)); }\nfn g() { let _ = Policy::none(); }\n";
    assert!(
        !code_disables_redirects(swapped),
        "a live limited policy with an unrelated Policy::none marker must fail"
    );
}

pub(crate) fn egress_sources_disable_redirects() -> bool {
    [
        include_str!("../lib.rs"),
        include_str!("../constructor.rs"),
        include_str!("../egress_client.rs"),
    ]
    .into_iter()
    .all(redirect_policy_none_in_code)
}

/// Every `.redirect(` configures the client with `Policy::none()`.
/// A `Policy::none()` elsewhere in the file does not count.
fn redirect_policy_none_in_code(src: &str) -> bool {
    let src = strip_noise(src);
    let bytes = src.as_bytes();
    let mut index = 0usize;
    let mut saw = false;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if src[index..].starts_with(".redirect(") {
            let open = index + ".redirect".len();
            let Some(arg) = paren_inside(&src[open..]) else {
                return false;
            };
            if !arg_is_policy_none(arg) {
                return false;
            }
            saw = true;
            index = open + 1;
            continue;
        }
        index += 1;
    }
    saw
}

fn arg_is_policy_none(arg: &str) -> bool {
    let compact = code_compact(arg);
    let Some(at) = policy_none_at(&compact) else {
        return false;
    };
    let before = &compact[..at];
    let after = &compact[at + "Policy::none()".len()..];
    after.is_empty() && (before.is_empty() || before.ends_with("::"))
}

fn policy_none_at(compact: &str) -> Option<usize> {
    let needle = "Policy::none()";
    let mut offset = 0usize;
    while let Some(rel) = compact[offset..].find(needle) {
        let at = offset + rel;
        let boundary = at == 0 || compact.as_bytes()[at - 1] == b':';
        if boundary {
            return Some(at);
        }
        offset = at + needle.len();
    }
    None
}

pub(crate) fn code_compact(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = String::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if !bytes[index].is_ascii_whitespace() {
            out.push(bytes[index] as char);
        }
        index += 1;
    }
    out
}

fn paren_inside(at_paren: &str) -> Option<&str> {
    let bytes = at_paren.strip_prefix('(')?.as_bytes();
    let mut depth = 1i32;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
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
