//! In-place updates that void an HTTPS guard on the sent URL.
use super::super::sync_target_pact_norm::{find_code_byte, is_keyword_at, match_brace, string_len};

/// `name` is assigned or updated in place, so the checked value is not the sent one.
/// `url = evil` is an assignment. `set_scheme`, `clone_from`, `push_str`, and any
/// other call on that binding mutate it without `=`. So do UFCS
/// `Url::set_scheme(&mut url, …)`, `mem::replace` / `mem::swap`, a rebinding
/// `let u = &mut url`, and a tuple assignment `(url,) = …`. An `if let` /
/// `while let` pattern is none of these: it binds `name` only inside the
/// condition's block.
pub(super) fn shadows(source: &str, name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    if mut_borrowed(source, name) || tuple_assigned(source, name) {
        return true;
    }
    let bytes = source.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if is_keyword_at(bytes, index, name.as_bytes())
            && !cond_let_binds(source, name, index)
            && (assigns_name(bytes, index + name.len()) || mutates_name(source, index + name.len()))
        {
            return true;
        }
        if mem_swap_touches(source, index, name) {
            return true;
        }
        index += 1;
    }
    false
}

const READ_ONLY_METHODS: &[&str] = &[
    "as_str", "as_ref", "scheme", "host_str", "host", "path", "clone", "parse",
];

/// `.set_scheme(…)`, `.clone_from(…)`, `.push_str(…)`, and any other call.
fn mutates_name(source: &str, mut at: usize) -> bool {
    let bytes = source.as_bytes();
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    if bytes.get(at) != Some(&b'.') {
        return false;
    }
    at += 1;
    if at >= bytes.len() || !super::is_ident_byte(bytes[at]) {
        return false;
    }
    let start = at;
    while at < bytes.len() && super::is_ident_byte(bytes[at]) {
        at += 1;
    }
    if READ_ONLY_METHODS.contains(&&source[start..at]) {
        return false;
    }
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    bytes.get(at) == Some(&b'(') || source[at..].starts_with("::")
}

/// `&mut name` in any later expression: UFCS `Url::set_scheme`, `mem::replace`,
/// or `let alias = &mut name`.
fn mut_borrowed(source: &str, name: &str) -> bool {
    let bytes = source.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if source[index..].starts_with("&mut") {
            let mut at = index + "&mut".len();
            while at < bytes.len() && bytes[at].is_ascii_whitespace() {
                at += 1;
            }
            if is_keyword_at(bytes, at, name.as_bytes()) {
                return true;
            }
        }
        index += 1;
    }
    false
}

/// `(name,) = …` and other tuple patterns. `name = …` is not this form.
fn tuple_assigned(source: &str, name: &str) -> bool {
    let bytes = source.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if super::bind::is_single_eq(bytes, index) && tuple_lhs_binds(&source[..index], name) {
            return true;
        }
        index += 1;
    }
    false
}

fn tuple_lhs_binds(before_eq: &str, name: &str) -> bool {
    let bytes = before_eq.as_bytes();
    let mut depth = 0i32;
    let mut index = bytes.len();
    let mut start = 0usize;
    while index > 0 {
        index -= 1;
        match bytes[index] {
            b')' | b']' => depth += 1,
            // A finished block is the previous statement, not this LHS.
            b'}' if depth == 0 => {
                start = index + 1;
                break;
            }
            b'}' => depth += 1,
            b'(' | b'[' | b'{' if depth > 0 => depth -= 1,
            b';' | b'{' if depth == 0 => {
                start = index + 1;
                break;
            }
            _ => {}
        }
    }
    let mut lhs = before_eq[start..].trim();
    // `if let (url,) = …` / `while let (url,) = …` bind only inside the
    // condition's block. `pattern::let_pattern_intro` refuses them as URL
    // bindings; they are not reassignments either.
    for head in ["if", "while"] {
        if let Some(rest) = super::pattern::strip_prefix_kw(lhs, head) {
            if super::pattern::strip_prefix_kw(rest, "let").is_some() {
                return false;
            }
        }
    }
    if let Some(rest) = super::pattern::strip_prefix_kw(lhs, "let") {
        lhs = rest;
        if let Some(rest) = super::pattern::strip_prefix_kw(lhs, "mut") {
            lhs = rest;
        }
    }
    let Some(inside) = super::pattern::whole_tuple(lhs.trim()) else {
        return false;
    };
    super::pattern::tuple_parts(inside)
        .into_iter()
        .any(|elem| super::pattern::pattern_binds(elem, name))
}

/// `if let url = evil` / `while let mut url = evil` bind `url` only inside
/// the condition's block, so they are not assignments to the checked binding
/// — once that block closes before the send. A send inside the block still
/// uses the rebound value, and must keep failing closed.
fn cond_let_binds(source: &str, name: &str, name_at: usize) -> bool {
    let mut head = source[..name_at].trim_end();
    for _ in 0..3 {
        let stripped = super::pattern::strip_suffix_kw(head, "mut")
            .or_else(|| super::pattern::strip_suffix_kw(head, "ref"));
        match stripped {
            Some(rest) => head = rest,
            None => break,
        }
    }
    let Some(rest) = super::pattern::strip_suffix_kw(head, "let") else {
        return false;
    };
    let conditional = super::pattern::strip_suffix_kw(rest, "if").is_some()
        || super::pattern::strip_suffix_kw(rest, "while").is_some();
    if !conditional {
        return false;
    }
    let bytes = source.as_bytes();
    let Some(eq) = super::bind::eq_after_name(bytes, name_at + name.len()) else {
        return false;
    };
    // The first code `{` after the pattern's `=` opens the condition's block.
    // If it never closes within this scan, the send sits inside it.
    match find_code_byte(bytes, eq + 1, b'{') {
        Some(open) => match_brace(bytes, open).is_some(),
        None => false,
    }
}

fn mem_swap_touches(source: &str, index: usize, name: &str) -> bool {
    const MARK: &str = "mem::swap";
    if !source[index..].starts_with(MARK) {
        return false;
    }
    let bytes = source.as_bytes();
    if index > 0 && super::is_ident_byte(bytes[index - 1]) {
        return false;
    }
    let Some(args) = super::bind::call_inside(&source[index + MARK.len()..]) else {
        return false;
    };
    swap_args_include(args, name)
}

fn swap_args_include(args: &str, name: &str) -> bool {
    let bytes = args.as_bytes();
    let (mut depth, mut index, mut start) = (0i32, 0usize, 0usize);
    let mut hit = false;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' if depth > 0 => depth -= 1,
            b',' if depth == 0 => {
                hit |= arg_is_name(&args[start..index], name);
                start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    hit || arg_is_name(&args[start..], name)
}

fn arg_is_name(arg: &str, name: &str) -> bool {
    super::bind::plain_ident(super::bind::strip_ref(arg.trim())) == Some(name)
}

fn assigns_name(bytes: &[u8], mut at: usize) -> bool {
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    // `url += evil` replaces the checked value. `==` is not an assignment.
    if bytes.get(at) == Some(&b'+') && bytes.get(at + 1) == Some(&b'=') {
        return true;
    }
    if bytes.get(at) == Some(&b':') && bytes.get(at + 1) != Some(&b':') {
        at = super::bind::skip_ascription(bytes, at + 1);
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
    }
    super::bind::is_single_eq(bytes, at)
}

#[cfg(test)]
mod probes {
    use super::super::credentialed_send_https_gaps;

    #[test]
    fn p5_url_add_assign_and_nested_tuple_shadow() {
        let add = r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } url += evil; client.get(url).send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(add), (1, 1), "{add}");
        let nested = r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } ((url,),) = ((evil,),); client.get(url).send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(nested), (1, 1), "{nested}");
        let kept = r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } client.get(url).send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(kept), (1, 0), "{kept}");
        let quoted = r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } let _ = "url += evil"; client.get(url).send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(quoted), (1, 0), "{quoted}");
    }

    /// `(url,) = …` right after a `}`-terminated guard block must void the
    /// HTTPS guard on the guard side: the backward scan stops at the finished
    /// block, so the LHS is parsed as a tuple rather than swallowed into the
    /// preceding statement. Asserted through `shadows` directly — the
    /// end-to-end gap count alone would be masked by dest-side pattern
    /// tracking at the send.
    #[test]
    fn chunk04_tuple_lhs_after_guard_block_voids_guard_side() {
        let voided = r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } (url,) = (evil,); client.get(url).send().await?; }"#;
        assert!(super::shadows(voided, "url"), "{voided}");
        assert_eq!(credentialed_send_https_gaps(voided), (1, 1), "{voided}");
        let nested = r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } ((url,),) = ((evil,),); client.get(url).send().await?; }"#;
        assert!(super::shadows(nested, "url"), "{nested}");
        let kept = r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } if let (url,) = (evil,) { let _ = 1; } client.get(url).send().await?; }"#;
        assert!(!super::shadows(kept, "url"), "{kept}");
        let untouched = r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } client.get(url).send().await?; }"#;
        assert!(!super::shadows(untouched, "url"), "{untouched}");
    }

    /// `if let` / `while let` bind `url` only inside the condition's block,
    /// so a send after the block keeps its scheme guard — the tuple pattern
    /// forms included, matching `pattern.rs`. A send inside the block reads
    /// the rebound value and still fails closed, and a plain `let` or an
    /// assignment still voids the guard.
    #[test]
    fn chunk02_if_and_while_let_patterns_do_not_void_the_guard() {
        let kept = [
            r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } if let url = evil { let _ = 1; } client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } while let url = evil { break; } client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } if let mut url = evil { let _ = 1; } client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } if let (url,) = (evil,) { let _ = 1; } client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } while let (url,) = (evil,) { break; } client.get(url).send().await?; }"#,
            r#"async fn f() { let request = client.get(url); if url.scheme() != "https" { return Err("x".into()); } if let (url,) = (evil,) { let _ = 1; } request.send().await?; }"#,
        ];
        for sample in kept {
            assert_eq!(credentialed_send_https_gaps(sample), (1, 0), "{sample}");
        }
        let voided = [
            r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } if let url = evil { client.get(url).send().await?; } }"#,
            r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } let url = evil; client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } let mut url = evil; client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } url = evil; client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } (url,) = (evil,); client.get(url).send().await?; }"#,
        ];
        for sample in voided {
            assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
        }
    }

    /// Read-only URL inspection (`as_str`, `host_str`, `path`, …) after the
    /// guard keeps it: the checked value is unchanged (Codex
    /// PRRT_kwDOTwzAKs65i9UU).
    #[test]
    fn codex_thread_read_only_url_methods_keep_the_guard() {
        let kept = [
            (
                r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } let _ = url.as_str(); client.get(url).send().await?; }"#,
                (1, 0),
            ),
            (
                r#"async fn f() { let _ = url.as_str(); client.get(url).send().await?; }"#,
                (1, 1),
            ),
            (
                r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } let _ = url.host_str(); let _ = url.path(); client.get(url).send().await?; }"#,
                (1, 0),
            ),
        ];
        for (sample, expected) in kept {
            assert_eq!(credentialed_send_https_gaps(sample), expected, "{sample}");
        }
        let voided = [
            r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } url.set_scheme("http"); client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } url.push_str(evil); client.get(url).send().await?; }"#,
        ];
        for sample in voided {
            assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
        }
    }
}
