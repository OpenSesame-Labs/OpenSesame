//! `let`/`=` bindings whose right-hand side still points at the response receiver.
use super::super::sync_target_pact_norm::{is_keyword_at, string_len};
use super::marker::{code_marker, find_marker, is_ident_byte, is_ident_char};
use super::peel::{strip_ref, unwrap_value};

struct BindHit {
    depth: i32,
    name: String,
    at: usize,
}

/// Visible binding of `name` and the source position of its RHS ident.
/// A `let` inside a finished block does not stay visible. The position lets
/// the next hop ignore a later shadow of that RHS.
pub(super) fn let_bind_rhs(prefix: &str, name: &str) -> Option<(String, usize)> {
    let bytes = prefix.as_bytes();
    let mut index = 0usize;
    let mut depth = 0i32;
    let mut stack: Vec<BindHit> = Vec::new();
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'{' => {
                depth += 1;
                index += 1;
                continue;
            }
            b'}' => {
                if depth > 0 {
                    depth -= 1;
                }
                while stack.last().is_some_and(|hit| hit.depth > depth) {
                    stack.pop();
                }
                index += 1;
                continue;
            }
            _ => {}
        }
        if let Some(hit) = binding_hit(prefix, bytes, index, name) {
            push_hit(&mut stack, depth, hit);
        }
        index += 1;
    }
    stack.last().map(|hit| (hit.name.clone(), hit.at))
}

struct FoundBind {
    is_let: bool,
    name: String,
    at: usize,
}

fn binding_hit(prefix: &str, bytes: &[u8], index: usize, name: &str) -> Option<FoundBind> {
    if is_keyword_at(bytes, index, b"let") {
        let (bound, at) = let_named_rhs(prefix, bytes, index, name)?;
        return Some(FoundBind {
            is_let: true,
            name: bound,
            at,
        });
    }
    if is_keyword_at(bytes, index, name.as_bytes()) && !field_place(bytes, index) {
        let (bound, at) = assign_rhs(prefix, bytes, index + name.len())?;
        return Some(FoundBind {
            is_let: false,
            name: bound,
            at,
        });
    }
    None
}

/// `self.reply = status` and `Type::reply = status` are not local rebinds.
fn field_place(bytes: &[u8], index: usize) -> bool {
    let mut at = index;
    while at > 0 && bytes[at - 1].is_ascii_whitespace() {
        at -= 1;
    }
    if at > 0 && bytes[at - 1] == b'.' {
        return true;
    }
    at >= 2 && bytes[at - 1] == b':' && bytes[at - 2] == b':'
}

fn push_hit(stack: &mut Vec<BindHit>, depth: i32, hit: FoundBind) {
    if !hit.is_let {
        if let Some(top) = stack.last_mut() {
            top.name = hit.name;
            top.at = hit.at;
            return;
        }
    } else if stack.last().is_some_and(|top| top.depth == depth) {
        stack.pop();
    }
    stack.push(BindHit {
        depth,
        name: hit.name,
        at: hit.at,
    });
}

fn let_named_rhs(prefix: &str, bytes: &[u8], index: usize, name: &str) -> Option<(String, usize)> {
    let mut at = skip_ws(bytes, index + 3);
    if is_keyword_at(bytes, at, b"mut") {
        at = skip_ws(bytes, at + 3);
    }
    if bytes.get(at) == Some(&b'(') {
        return super::tuple::let_tuple_named_rhs(prefix, bytes, at, name);
    }
    let bind = read_ident_at(prefix, at)?;
    at = skip_ws(bytes, at + bind.len());
    if bytes.get(at) == Some(&b':') && bytes.get(at + 1) != Some(&b':') {
        at = skip_ws(bytes, skip_type(bytes, at + 1));
    }
    if !is_single_eq(bytes, at) || bind != name {
        return None;
    }
    rhs_ident(prefix, skip_ws(bytes, at + 1))
}

fn assign_rhs(prefix: &str, bytes: &[u8], at: usize) -> Option<(String, usize)> {
    let at = skip_ws(bytes, at);
    if !is_single_eq(bytes, at) {
        return None;
    }
    rhs_ident(prefix, skip_ws(bytes, at + 1))
}

pub(super) fn skip_ws(bytes: &[u8], mut at: usize) -> usize {
    while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
        at += 1;
    }
    at
}

/// RHS leading ident of a binding, following `if` / `match` branch values and
/// credentialed send expressions to their response root.
pub(super) fn rhs_ident(source: &str, at: usize) -> Option<(String, usize)> {
    let raw = source.get(at..)?;
    let lead = raw.len() - raw.trim_start().len();
    let trimmed = &raw[lead..];
    let expr = strip_ref(unwrap_value(trimmed));
    let expr_at = at + lead + slice_offset(trimmed, expr);
    // The RHS ends at its statement: a later `.send()` / `sqlx::` must not be
    // mistaken for this binding's RHS (`let reply = status; request.send()`).
    let expr = rhs_stmt(expr);
    if matches!(read_ident_at(expr, 0).as_deref(), Some("if" | "match")) {
        if let Some(found) = branch_response(source, expr, expr_at) {
            return Some(found);
        }
    }
    if credentialed_send_expr(expr) {
        return Some(("response".to_string(), expr_at));
    }
    let name = read_ident_at(expr, 0)?;
    Some((name, expr_at))
}

/// The binding RHS ends at the first depth-0 `;` or `,`, or at a close
/// delimiter that drops depth below zero (the end of an enclosing group).
/// Same stops as `branch_response`: without them the credentialed-send check
/// would run into the next statement.
fn rhs_stmt(expr: &str) -> &str {
    let bytes = expr.as_bytes();
    let mut depth = 0i32;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                if depth == 0 {
                    return &expr[..index];
                }
                depth -= 1;
            }
            b';' | b',' if depth == 0 => return &expr[..index],
            _ => {}
        }
        index += 1;
    }
    expr
}

fn slice_offset(outer: &str, inner: &str) -> usize {
    inner.as_ptr() as usize - outer.as_ptr() as usize
}

/// An `if` / `match` initializer aliases the response when any branch value
/// does. The scan stops at the end of the initializer: a depth-0 `;` ends the
/// statement, a depth-0 `,` ends an argument, and a close paren that takes
/// depth below zero ends the enclosing group. Without those stops the scan
/// would run into the next statement (`; let body: reqwest::Body = ...`),
/// where a receiver name is a decoy for this binding.
fn branch_response(source: &str, expr: &str, expr_at: usize) -> Option<(String, usize)> {
    let bytes = expr.as_bytes();
    let mut index = 0usize;
    let mut depth = 0i32;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                if depth == 0 {
                    return None;
                }
                depth -= 1;
            }
            b';' | b',' if depth == 0 => return None,
            _ => {}
        }
        if !is_ident_byte(bytes[index]) {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len() && is_ident_byte(bytes[index]) {
            index += 1;
        }
        let name = &expr[start..index];
        if tracks_branch_ident(source, expr_at + start, name) {
            return Some((name.to_string(), expr_at + start));
        }
    }
    None
}

fn tracks_branch_ident(source: &str, at: usize, name: &str) -> bool {
    if matches!(name, "if" | "else" | "match" | "return" | "async") {
        return false;
    }
    super::tracks_response_receiver(source, at, name.to_string())
}

fn credentialed_send_expr(expr: &str) -> bool {
    send_marker(expr, ".send")
        || send_marker(expr, "::send")
        || (!code_marker(expr, "sqlx::")
            && (send_marker(expr, ".execute") || send_marker(expr, "::execute")))
}

fn send_marker(expr: &str, marker: &str) -> bool {
    find_marker(expr, marker, |index| {
        !expr[index + marker.len()..]
            .chars()
            .next()
            .is_some_and(is_ident_char)
    })
}

pub(crate) fn plain_name(expr: &str) -> Option<String> {
    let expr = strip_ref(unwrap_value(expr.trim()));
    let name = read_ident_at(expr, 0)?;
    expr[name.len()..].trim().is_empty().then_some(name)
}
pub(super) fn read_ident_at(source: &str, at: usize) -> Option<String> {
    let rest = source.get(at..)?;
    let name: String = rest.chars().take_while(|ch| is_ident_char(*ch)).collect();
    (!name.is_empty()).then_some(name)
}

pub(super) fn is_single_eq(bytes: &[u8], index: usize) -> bool {
    bytes.get(index) == Some(&b'=')
        && !matches!(bytes.get(index + 1), Some(b'=' | b'>'))
        && !matches!(
            index.checked_sub(1).and_then(|prev| bytes.get(prev)),
            Some(b'=' | b'!' | b'<' | b'>')
        )
}

pub(super) fn skip_type(bytes: &[u8], start: usize) -> usize {
    let mut depth = 0i32;
    let mut index = start;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'<' => depth += 1,
            b')' | b']' | b'>' if depth > 0 => depth -= 1,
            b',' | b')' | b'{' | b'=' | b'|' if depth == 0 => return index,
            b'-' if depth == 0 && bytes.get(index + 1) == Some(&b'>') => return index,
            _ => {}
        }
        index += 1;
    }
    index
}

#[cfg(test)]
mod probes {
    use crate::tests::sync_target_pact_scan::response_body_reads;

    fn reads(sample: &str) -> bool {
        !response_body_reads(sample).is_empty()
    }

    #[test]
    fn council_r3_field_assign_does_not_rebind_local() {
        let hits = [
            "let reply = response; self.reply = status; reply.into()",
            "let reply = response; self . reply = status; reply.into()",
            "let reply = response; Type::reply = status; reply.into()",
            "let mut reply = other; reply = response; reply.into()",
        ];
        for sample in hits {
            assert!(reads(sample), "local reply stays the response: {sample}");
        }
        let misses = [
            "let reply = status; self.reply = response; reply.into()",
            "let reply = status; obj.reply = response; reply.into()",
            "let reply = status; Type::reply = response; reply.into()",
        ];
        for sample in misses {
            assert!(
                !reads(sample),
                "field assign must not rebind the local: {sample}"
            );
        }
    }

    /// Compound assignments mutate, they do not rebind — and this code
    /// already cannot confuse them: the binding scan's cursor stops on the
    /// operator's first byte (`+` of `+=`), which is not `=`, so
    /// `is_single_eq` rejects it before the prev-byte check could matter.
    /// This probe proves the Kimi council r2 chunk05 claim false and pins
    /// the behavior: `reply += chunk` keeps the tracked response, a plain
    /// `=` still replaces it.
    #[test]
    fn kimi_council_r2_compound_assign_keeps_prior_binding() {
        let kept = [
            "let reply = response; reply += chunk; reply.into()",
            "let reply = response; reply |= chunk; reply.into()",
            "let reply = response; reply &= chunk; reply.into()",
            "let reply = response; reply -= chunk; reply.into()",
            "let reply = response; reply *= chunk; reply.into()",
            "let reply = response; reply /= chunk; reply.into()",
            "let reply = response; reply %= chunk; reply.into()",
            "let reply = response; reply ^= chunk; reply.into()",
            "let reply = response; reply <<= bits; reply.into()",
            "let reply = response; reply >>= bits; reply.into()",
        ];
        for sample in kept {
            assert!(
                reads(sample),
                "compound assign keeps the response: {sample}"
            );
        }
        let misses = [
            "let reply = response; reply = chunk; reply.into()",
            "let reply = other; reply.into()",
        ];
        for sample in misses {
            assert!(!reads(sample), "a plain rebind still replaces: {sample}");
        }
    }

    /// The credentialed-send check stops at the binding's statement: a later
    /// `.send()` must not make `let reply = status` response-rooted, and a
    /// later `sqlx::` must not suppress a real `execute` on the RHS
    /// (Kimi council chunk06 P1).
    #[test]
    fn kimi_council_r3_rhs_scan_stops_at_statement_end() {
        let misses = [
            "let reply = status; request.send(); reply.into()",
            "let reply = status; query.execute(request).await?; reply.into()",
            "let reply = status; client.get(other).send().await?; reply.into()",
            "let reply = (status); request.send(); reply.into()",
        ];
        for sample in misses {
            assert!(
                !reads(sample),
                "a later send is not this binding's RHS: {sample}"
            );
        }
        let hits = [
            "let reply = request.send(); reply.into()",
            "let reply = client.get(url).send().await?; side_effect(); reply.into()",
            "let reply = client.execute(request).await?; sqlx::query(\"select 1\"); reply.into()",
        ];
        for sample in hits {
            assert!(
                reads(sample),
                "the RHS send stays response-rooted: {sample}"
            );
        }
    }
}
