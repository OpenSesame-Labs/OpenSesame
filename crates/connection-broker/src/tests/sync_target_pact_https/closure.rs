//! Closure-local `return` does not satisfy the HTTPS guard.
use super::super::sync_target_pact_norm::non_code_len;
use super::is_ident_char;

pub(crate) fn closure_owns(before: &str) -> bool {
    let bytes = before.as_bytes();
    let code = code_mask(bytes);
    let mut index = 0usize;
    while index < bytes.len() {
        // A `|` inside a comment or string is not a closure pipe.
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes[index] == b'|'
            && pipe_is_closure(before, index, &code)
            && closure_body_at(before, index).is_some_and(|at| runs_to_end(&before[at..]))
        {
            return true;
        }
        index += 1;
    }
    false
}

fn pipe_is_closure(body: &str, pipe: usize, code: &[bool]) -> bool {
    let bytes = body.as_bytes();
    // Skip comment/string regions too, like `guard.rs::preceded_by_else`: on
    // a raw prefix, `flag | /* c */ |x|` is a closure operand of `|`, so its
    // `return` is closure-local and must not satisfy the guard
    // (Kimi council R5 chunk03).
    let mut at = pipe;
    while at > 0 && (!code[at - 1] || bytes[at - 1].is_ascii_whitespace()) {
        at -= 1;
    }
    if at == 0 {
        return true;
    }
    let prev = bytes[at - 1];
    // `||` / `&&` are not closures, but `|x|` after them is: `flag || |x| return`.
    // Compacted source glues `|| |x|` into `|||x|`, so the closure pipe is the
    // third pipe in that run. A pipe after `&` is the same shape for `&&`.
    if prev == b'&' {
        return true;
    }
    if prev == b'|' && logic_or_closure(bytes, pipe, at) {
        return true;
    }
    matches!(prev, b'=' | b'(' | b'{' | b',' | b';' | b'[')
        || matches!(trailing_name(&body[..at]), "move" | "async")
}

/// `true` for code bytes; strings and comments are not code. Mirrors
/// `guard.rs::code_mask`.
fn code_mask(bytes: &[u8]) -> Vec<bool> {
    let mut code = vec![true; bytes.len()];
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            let end = (index + len).min(bytes.len());
            for slot in &mut code[index..end] {
                *slot = false;
            }
            index = end.max(index + 1);
            continue;
        }
        index += 1;
    }
    code
}

/// Closure parameter pipe after `||`, not the operator's own second `|`.
fn logic_or_closure(bytes: &[u8], pipe: usize, prev_at: usize) -> bool {
    if prev_at < pipe {
        return prev_at > 0 && bytes[prev_at - 1] == b'|';
    }
    let mut start = pipe;
    while start > 0 && bytes[start - 1] == b'|' {
        start -= 1;
    }
    pipe - start == 2
}

fn closure_body_at(body: &str, pipe: usize) -> Option<usize> {
    let bytes = body.as_bytes();
    if bytes.get(pipe + 1) == Some(&b'|') {
        return Some(pipe + 2);
    }
    let (mut depth, mut index) = (0i32, pipe + 1);
    while index < bytes.len() {
        // Comments are not code: a `;` / `=` inside a comment does not end
        // the parameter list (Kimi council chunk03 P2).
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' if depth > 0 => depth -= 1,
            b'|' if depth == 0 => return Some(index + 1),
            b';' | b'=' if depth == 0 => return None,
            _ => {}
        }
        index += 1;
    }
    None
}

fn runs_to_end(body: &str) -> bool {
    let bytes = body.as_bytes();
    // `brace` counts `{…}` only. `>` inside a const-generic block (`{1 > 0}`)
    // is a comparison. Treating it as the turbofish closer drops `angle`, so
    // the comma in `::<{1 > 0}, T>` looks like the end of the closure and a
    // later `return` counts as the function guard.
    let (mut depth, mut brace, mut angle, mut index) = (0i32, 0i32, 0i32, 0usize);
    while index < bytes.len() {
        // Comments are not code: a `;` / `,` inside a comment does not end
        // the body, so a closure-local `return` stays closure-owned
        // (Kimi council chunk03 P2).
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' => depth += 1,
            b'{' => {
                depth += 1;
                brace += 1;
            }
            b')' | b']' => {
                if depth == 0 {
                    return false;
                }
                depth -= 1;
            }
            b'}' => {
                if depth == 0 {
                    return false;
                }
                depth -= 1;
                brace = brace.saturating_sub(1);
            }
            // `x > 0` is a comparison. A `>` at angle 0 does not end the body.
            // Neither does `>` / `<` while a const-generic block is open, nor
            // the `>` of a `->` return type (`fn() -> R`) inside the turbofish.
            b'<' if brace == 0 && generic_lt(bytes, index, angle) => angle += 1,
            b'>' if brace == 0
                && angle > 0
                && bytes.get(index + 1) != Some(&b'=')
                && bytes.get(index.wrapping_sub(1)) != Some(&b'-') =>
            {
                angle -= 1;
            }
            b',' | b';' if depth == 0 && angle == 0 => return false,
            _ => {}
        }
        index += 1;
    }
    true
}

/// Turbofish, nested generics, and `as Type<…>`. Comparison `<` stays at angle 0.
fn generic_lt(bytes: &[u8], index: usize, angle: i32) -> bool {
    if bytes.get(index + 1) == Some(&b'=') {
        return false;
    }
    if angle > 0 || (index >= 2 && bytes[index - 1] == b':' && bytes[index - 2] == b':') {
        return true;
    }
    as_type_lt(bytes, index)
}

fn as_type_lt(bytes: &[u8], index: usize) -> bool {
    if index == 0 || !super::is_ident_byte(bytes[index - 1]) {
        return false;
    }
    let mut at = index;
    while at > 0 && super::is_ident_byte(bytes[at - 1]) {
        at -= 1;
    }
    while at > 0 && bytes[at - 1].is_ascii_whitespace() {
        at -= 1;
    }
    at >= 2 && &bytes[at - 2..at] == b"as" && (at == 2 || !super::is_ident_byte(bytes[at - 3]))
}

pub(super) fn trailing_name(prefix: &str) -> &str {
    let mut start = prefix.len();
    for (index, ch) in prefix.char_indices().rev() {
        if !is_ident_char(ch) {
            break;
        }
        start = index;
    }
    &prefix[start..]
}

#[cfg(test)]
mod probes {
    use super::super::credentialed_send_https_gaps;

    #[test]
    fn council_p1_comparison_does_not_end_closure_body() {
        let open = [
            r#"async fn f() { if url.scheme() != "https" { |x| x > 0 || return Err("x".into()); } client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { let _ = |x| x > 0 || return Err("x".into()); } client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { || x > 0 || return Err("x".into()); } client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { |x| x < 1 || return Err("x".into()); } client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { |x| x >= 1 || return Err("x".into()); } client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { |x| foo::<A, B>() || return Err("x".into()); } client.get(url).send().await?; }"#,
        ];
        for sample in open {
            assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
        }
        let kept = r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } client.get(url).send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(kept), (1, 0));
    }

    #[test]
    fn chunk02_const_generic_gt_does_not_end_closure() {
        // `{1 > 0}` sits inside the turbofish. That `>` is a comparison, so the
        // comma before `B` is still inside `::<…>` and the `return` stays in
        // the closure.
        let open = [
            r#"async fn f() { if url.scheme() != "https" { |x| foo::<{1 > 0}, B>() || return Err("x".into()); } client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { |x| foo::<{1 >> 0}, B>() || return Err("x".into()); } client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { |x| foo::<{1 >= 0}, B>() || return Err("x".into()); } client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { |x| foo::<{1 < 0}, B>() || return Err("x".into()); } client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { |x| foo::<Bar<{1 > 0}>, T>() || return Err("x".into()); } client.get(url).send().await?; }"#,
        ];
        for sample in open {
            assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
        }
        let kept = r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } client.get(url).send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(kept), (1, 0));
    }

    /// Comment bytes are not code on the raw-prefix path either: a `;` or
    /// `=` inside a comment must not end a closure's parameter list or body,
    /// so a closure-local `return` stays closure-owned and cannot satisfy
    /// the guard (Kimi council chunk03 P2).
    #[test]
    fn kimi_council_r3_commented_semicolon_does_not_end_closure() {
        for before in [
            "|x| x /* ; */ || ",
            "|x| x // ;\n|| ",
            "|x /* ; */| x || ",
            "|x // ;\n| x || ",
        ] {
            assert!(super::closure_owns(before), "{before}");
        }
        // Controls: a real depth-0 `;` still ends the body, and a closure
        // whose body does not run to the end does not own the return.
        assert!(!super::closure_owns("|x| x; y || "));
        assert!(!super::closure_owns("arr.map(|x| x) || "));
        // Through `guarded`: the closure-local return must not fail-close
        // when the closure body carries a comment `;`. Without a `||`
        // short-circuit in the statement, the comment `;` is the only thing
        // that could wrongly end the closure body.
        let prefix = r#"{if url.scheme()!="https" { |x| x /* ; */ return Err("x".into()); } client.get(url)."#;
        assert!(!super::super::guard::guarded(prefix, Some("url")), "{prefix}");
        let kept = r#"{if url.scheme()!="https" { return Err("x".into()); } client.get(url)."#;
        assert!(super::super::guard::guarded(kept, Some("url")), "{kept}");
    }

    /// The backward walk that classifies a pipe must skip comments and
    /// strings, like `guard.rs::preceded_by_else`: on a raw prefix,
    /// `flag | /* c */ |x| return` is a closure operand of `|`, so the
    /// `return` is closure-local and cannot satisfy the guard
    /// (Kimi council R5 chunk03).
    #[test]
    fn kimi_council_r5_commented_pipe_still_opens_closure() {
        for before in [
            "flag | /* c */ |x| ",
            "flag | // c\n|x| ",
            "flag || /* c */ |x| ",
            "flag = /* c */ |x| ",
            "flag & /* c */ |x| ",
            "call(move /* c */ |x| ",
            "flag | \"s\" |x| ",
        ] {
            assert!(super::closure_owns(before), "{before}");
        }
        // Controls: a `|` inside a comment is not a closure pipe, so a real
        // `return` after it still dominates, and a closure body that ends
        // before the statement end does not own the return.
        assert!(!super::closure_owns("/* |x| x */ "));
        assert!(!super::closure_owns("arr.map(|x| x) | /* c */ "));
        // Through `guarded`: the closure-local return must not read as the
        // branch's fail-close when a comment sits between the operator and
        // the closure.
        let prefix = r#"{if url.scheme()!="https" { flag | /* c */ |x| return Err("x".into()); } client.get(url)."#;
        assert!(
            !super::super::guard::guarded(prefix, Some("url")),
            "{prefix}"
        );
        let kept = r#"{if url.scheme()!="https" { return Err("x".into()); } client.get(url)."#;
        assert!(super::super::guard::guarded(kept, Some("url")), "{kept}");
    }

    #[test]
    fn chunk02_fn_ptr_return_arrow_does_not_close_turbofish() {
        // `fn() -> R` inside the turbofish: the `>` of `->` is not the closer,
        // so the comma after `R` is still inside `::<…>` and the `return` stays
        // in the closure.
        let open = [
            r#"async fn f() { if url.scheme() != "https" { |x| foo::<fn() -> R>() || return Err("x".into()); } client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { |x| foo::<fn() -> R, B>() || return Err("x".into()); } client.get(url).send().await?; }"#,
            r#"async fn f() { if url.scheme() != "https" { |x| foo::<fn() -> R, fn(A) -> B>() || return Err("x".into()); } client.get(url).send().await?; }"#,
        ];
        for sample in open {
            assert_eq!(credentialed_send_https_gaps(sample), (1, 1), "{sample}");
        }
        let kept = r#"async fn f() { if url.scheme() != "https" { return Err("x".into()); } client.get(url).send().await?; }"#;
        assert_eq!(credentialed_send_https_gaps(kept), (1, 0));
    }
}
