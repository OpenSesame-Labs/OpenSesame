//! In-place updates that void an HTTPS guard on the sent URL.
use super::super::sync_target_pact_norm::{is_keyword_at, string_len};

/// `name` is assigned or updated in place, so the checked value is not the sent one.
/// `url = evil` is an assignment. `set_scheme`, `clone_from`, `push_str`, and any
/// other call on that binding mutate it without `=`. So do UFCS
/// `Url::set_scheme(&mut url, …)`, `mem::replace` / `mem::swap`, a rebinding
/// `let u = &mut url`, and a tuple assignment `(url,) = …`.
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
    while at < bytes.len() && super::is_ident_byte(bytes[at]) {
        at += 1;
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
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' | b'{' if depth > 0 => depth -= 1,
            b';' | b'{' if depth == 0 => {
                start = index + 1;
                break;
            }
            _ => {}
        }
    }
    let mut lhs = before_eq[start..].trim();
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
    if bytes.get(at) == Some(&b':') && bytes.get(at + 1) != Some(&b':') {
        at = super::bind::skip_ascription(bytes, at + 1);
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
    }
    super::bind::is_single_eq(bytes, at)
}
