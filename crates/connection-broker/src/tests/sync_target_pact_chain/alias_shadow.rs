//! Visible dispatch alias at a call site.
//!
//! A later `let` or assignment shadows an earlier send alias until that binding
//! ends. A `let` inside a block does not kill the outer alias after the block,
//! and neither does a conditional reassignment: `dispatch = other_fn` inside an
//! `if` / `match` / `loop` arm only hides calls in that arm, because
//! `Path::send` is still the live value outside it. The establishing `let`
//! does not shadow its own call, and a comment cannot fake a rebind —
//! including the alias name inside a `let (` pattern.

use super::super::super::sync_target_pact_norm::{is_keyword_at, non_code_len, skip_until_semi};
use super::{path_prefix_start, statement_tail, value_eq, DispatchAlias};

/// A later `let` or `name = …` rebinding shadows an earlier send alias.
/// Comments cannot fake that pattern, and the establishing `let` does not
/// shadow itself.
pub(super) fn alias_shadowed(source: &str, alias: &DispatchAlias, call: usize) -> bool {
    let bytes = source.as_bytes();
    let mut index = alias.at;
    if is_keyword_at(bytes, index, b"let") || establishing_let(source, index) {
        index = skip_until_semi(bytes, index);
    }
    let mut depth = 0i32;
    // Depths of `let` shadows and reassignments still in scope. Both stick
    // only inside the block that introduced them, and both target the alias
    // itself, not a block-local shadow.
    let mut let_depths: Vec<i32> = Vec::new();
    let mut assigned_depths: Vec<i32> = Vec::new();
    while index < call {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' => depth += 1,
            b'}' if depth > 0 => {
                depth -= 1;
                while let_depths.last().is_some_and(|live| *live > depth) {
                    let_depths.pop();
                }
                while assigned_depths.last().is_some_and(|live| *live > depth) {
                    assigned_depths.pop();
                }
            }
            _ if rebind_at(source, bytes, index, &alias.name) => {
                if is_keyword_at(bytes, index, b"let") {
                    let_depths.push(depth);
                } else if let_depths.is_empty() {
                    assigned_depths.push(depth);
                }
            }
            _ => {}
        }
        index += 1;
    }
    !let_depths.is_empty() || !assigned_depths.is_empty()
}

/// `let name = …::send` introduces the alias. A `let` inside that initializer
/// is not a later rebind of the name.
fn establishing_let(source: &str, head: usize) -> bool {
    let path_start = path_prefix_start(source, head);
    let Some(eq) = value_eq(source.as_bytes(), path_start) else {
        return false;
    };
    let tail = statement_tail(source[..eq].trim_end()).trim_start();
    is_keyword_at(tail.as_bytes(), 0, b"let")
}

fn rebind_at(source: &str, bytes: &[u8], index: usize, name: &str) -> bool {
    if is_keyword_at(bytes, index, b"let") {
        return let_rebinds_name(source, bytes, index, name);
    }
    ident_then_single_eq(bytes, index, name)
}

/// `name = …` starting at `index`. `==`, `=>`, and `+=` are not rebinds.
fn ident_then_single_eq(bytes: &[u8], index: usize, name: &str) -> bool {
    if !is_keyword_at(bytes, index, name.as_bytes()) {
        return false;
    }
    let mut at = index + name.len();
    while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
        at += 1;
    }
    bytes.get(at) == Some(&b'=') && !matches!(bytes.get(at + 1), Some(b'=' | b'>'))
}

fn let_rebinds_name(source: &str, bytes: &[u8], index: usize, name: &str) -> bool {
    let mut at = index + 3;
    while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
        at += 1;
    }
    if is_keyword_at(bytes, at, b"mut") {
        at += 3;
        while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
            at += 1;
        }
    }
    if bytes.get(at) == Some(&b'(') {
        let Some(close) = let_pattern_close(bytes, at) else {
            return false;
        };
        return pattern_contains_name(&source[at..=close], name);
    }
    let start = at;
    while at < bytes.len() && super::super::is_ident_byte(bytes[at]) {
        at += 1;
    }
    &source[start..at] == name
}

/// Closing `)` of a `let (` / `let mut (` pattern. Nested parens count.
/// Strings and comments are not code, so a `)` inside them does not close.
fn let_pattern_close(bytes: &[u8], open: usize) -> Option<usize> {
    if bytes.get(open) != Some(&b'(') {
        return None;
    }
    let mut depth = 0i32;
    let mut index = open;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if bytes[index] == b'(' {
            depth += 1;
        } else if bytes[index] == b')' {
            depth -= 1;
            if depth == 0 {
                return Some(index);
            }
        }
        index += 1;
    }
    None
}

/// `name` as a pattern ident. A comment or string inside `let (` is not a rebind.
fn pattern_contains_name(pattern: &str, name: &str) -> bool {
    let bytes = pattern.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        if is_keyword_at(bytes, index, name.as_bytes()) {
            return true;
        }
        index += 1;
    }
    false
}

#[cfg(test)]
mod probes {
    use super::super::dispatch_alias_calls;

    /// A conditional rebind inside `if` / `match` / `loop` only hides calls
    /// in that arm: outside it, `Path::send` is still the live alias value.
    #[test]
    fn chunk01_conditional_rebind_does_not_shadow_outer_call() {
        let live = [
            "fn f() { let dispatch = Path::send; if cond { dispatch = other_fn; } dispatch(request); }",
            "fn f() { let dispatch = Path::send; if cond { dispatch = other_fn; } else { dispatch = other_fn; } dispatch(request); }",
            "fn f() { let dispatch = Path::send; match x { _ => { dispatch = other_fn; } } dispatch(request); }",
            "fn f() { let dispatch = Path::send; match x { 0 => dispatch = other_fn, _ => dispatch = other_fn, } dispatch(request); }",
            "fn f() { let dispatch = Path::send; loop { dispatch = other_fn; break; } dispatch(request); }",
            "fn f() { let dispatch = Path::send; while cond { dispatch = other_fn; } dispatch(request); }",
            "fn f() { let dispatch = Path::send; for i in it { dispatch = other_fn; } dispatch(request); }",
            "fn f() { let dispatch = Path::send; let f = || { dispatch = other_fn; }; dispatch(request); }",
        ];
        for sample in live {
            assert_eq!(dispatch_alias_calls(sample).len(), 1, "{sample}");
        }
        let dead = [
            "fn f() { let dispatch = Path::send; if cond { dispatch = other_fn; dispatch(request); } }",
            "fn f() { let dispatch = Path::send; match x { _ => { dispatch = other_fn; dispatch(request); } } }",
            "fn f() { let dispatch = Path::send; dispatch = other_fn; dispatch(request); }",
        ];
        for sample in dead {
            assert!(dispatch_alias_calls(sample).is_empty(), "{sample}");
        }
        let gaps = r#"async fn f() { let dispatch = reqwest::RequestBuilder::send; if parsed.scheme() != "https" { return Err("x".into()); } if cond { dispatch = other_fn; } dispatch(request).await?; }"#;
        assert_eq!(
            crate::tests::sync_target_pact_https::credentialed_send_https_gaps(gaps),
            (1, 0),
            "{gaps}"
        );
        let bare = r#"async fn f() { let dispatch = reqwest::RequestBuilder::send; if cond { dispatch = other_fn; } dispatch(request).await?; }"#;
        assert_eq!(
            crate::tests::sync_target_pact_https::credentialed_send_https_gaps(bare),
            (1, 1),
            "{bare}"
        );
    }
}
