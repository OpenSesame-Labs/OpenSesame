//! Bind a credentialed dispatch to the URL its builder was given.
use super::super::sync_target_pact_norm::{is_keyword_at, non_code_len};
#[path = "bind_tail.rs"]
mod bind_tail;

pub(super) use super::mutate::shadows;
pub(super) use bind_tail::{call_tail, ident_prefix, is_single_eq, stmt_end, strip_ref};

#[path = "bind_scope.rs"]
mod scope;
#[path = "bind_url.rs"]
mod url;
use scope::{brace_kind, else_follows, merge_both, merge_partial, note_binding};
pub(super) use url::{
    builder_url, call_inside, eq_after_name, plain_ident, skip_ascription, split_arg,
};
use url::{head_args, plain_receiver};

pub(super) fn dispatch_url(source: &str, fn_start: usize, at: usize) -> Option<String> {
    let expr = request_expr(source, fn_start, at)?;
    if expr.is_empty() {
        return None;
    }
    if let Some(url) = builder_url(expr) {
        return Some(url.to_string());
    }
    let name = plain_receiver(expr)?;
    assigned_builder_url(&source[fn_start..at], name)
}

fn request_expr<'a>(source: &'a str, fn_start: usize, at: usize) -> Option<&'a str> {
    let rest = &source[at..];
    if rest.starts_with(".send") {
        return Some(receiver_expr(source, fn_start, at));
    }
    let args = if rest.starts_with(".execute") || rest.starts_with("::") {
        head_args(rest)?
    } else {
        let tail = call_tail(source, at)?;
        call_inside(tail)?
    };
    let arg = split_arg(args, false);
    if !arg.is_empty() {
        return Some(arg);
    }
    rest.starts_with('.')
        .then(|| receiver_expr(source, fn_start, at))
}

fn receiver_expr<'a>(source: &'a str, fn_start: usize, dot: usize) -> &'a str {
    let bytes = source.as_bytes();
    let (mut start, mut depth, mut index) = (fn_start + 1, 0i32, fn_start + 1);
    while index < dot {
        // Strings and comments are not code: `=` / `;` inside `//` or
        // `/* */` must not cut the receiver away from its builder.
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' if depth > 0 => depth -= 1,
            b'}' if depth > 0 => depth = close_block(bytes, depth, index, &mut start),
            b';' if depth == 0 => start = index + 1,
            b'=' if depth == 0 && is_single_eq(bytes, index) => start = index + 1,
            _ => {}
        }
        index += 1;
    }
    &source[start..dot]
}

/// `if decoy { return } request.send` starts a new statement at `}`.
/// `{ builder }.send` and `} else {` stay one expression.
fn close_block(bytes: &[u8], depth: i32, brace: usize, start: &mut usize) -> i32 {
    let depth = depth - 1;
    if depth == 0 && !expr_continues(bytes, brace + 1) {
        *start = brace + 1;
    }
    depth
}

/// `.` / `?` / `else` keep the block in the same expression.
fn expr_continues(bytes: &[u8], mut at: usize) -> bool {
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    if matches!(bytes.get(at), Some(b'.' | b'?')) {
        return true;
    }
    is_keyword_at(bytes, at, b"else")
}

fn assigned_builder_url(prefix: &str, name: &str) -> Option<String> {
    let bytes = prefix.as_bytes();
    let mut scope = UrlScope::default();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = non_code_len(bytes, index) {
            index += len;
            continue;
        }
        index = scope.on_byte(prefix, name, index);
    }
    scope.visible()
}

#[derive(Clone)]
struct UrlBinding {
    depth: i32,
    url: String,
    /// `let` at the branch depth must not escape. An assignment may.
    is_let: bool,
}

struct PendingElse {
    entry: Vec<UrlBinding>,
    if_exit: Vec<UrlBinding>,
}

struct Cond {
    depth: i32,
    entry: Vec<UrlBinding>,
    else_arm: Option<Vec<UrlBinding>>,
}

#[derive(Default)]
struct UrlScope {
    depth: i32,
    layers: Vec<UrlBinding>,
    conds: Vec<Cond>,
    pending_else: Option<PendingElse>,
}

enum BraceKind {
    Block,
    Branch,
    Else,
    ElseIf,
}

impl UrlScope {
    fn visible(&self) -> Option<String> {
        self.layers.last().map(|binding| binding.url.clone())
    }

    fn on_byte(&mut self, prefix: &str, name: &str, index: usize) -> usize {
        match prefix.as_bytes()[index] {
            b'{' => self.open_brace(prefix, index),
            b'}' => self.close_brace(prefix, index),
            _ => self.on_binding(prefix, name, index),
        }
    }

    fn open_brace(&mut self, prefix: &str, index: usize) -> usize {
        let body = self.depth + 1;
        match brace_kind(prefix, index) {
            BraceKind::Else => self.push_else(body),
            BraceKind::ElseIf => self.push_else_if(body),
            BraceKind::Branch => {
                self.drop_pending_else();
                self.push_branch(body);
            }
            BraceKind::Block => self.drop_pending_else(),
        }
        self.depth = body;
        index + 1
    }

    fn push_else(&mut self, body: i32) {
        let Some(pending) = self.pending_else.take() else {
            return;
        };
        self.conds.push(Cond {
            depth: body,
            entry: pending.entry,
            else_arm: Some(pending.if_exit),
        });
    }

    fn push_else_if(&mut self, body: i32) {
        // `else if` does not cover the skipped arm. Fail closed unless the
        // preceding arm left the same URL the entry already had.
        if let Some(pending) = self.pending_else.take() {
            self.layers = merge_partial(&pending.entry, &pending.if_exit);
        }
        self.push_branch(body);
    }

    fn push_branch(&mut self, body: i32) {
        self.conds.push(Cond {
            depth: body,
            entry: self.layers.clone(),
            else_arm: None,
        });
    }

    fn drop_pending_else(&mut self) {
        if let Some(pending) = self.pending_else.take() {
            self.layers = merge_partial(&pending.entry, &pending.if_exit);
        }
    }

    fn close_brace(&mut self, prefix: &str, index: usize) -> usize {
        // `request = client.get(url)` with no earlier binding is stored at the
        // branch depth. Keep that assignment for the arm merge. A `let` here
        // shadows only the branch. A `}` inside a comment never reaches this
        // path: the scan skips non-code bytes.
        if self
            .conds
            .last()
            .is_some_and(|cond| cond.depth == self.depth)
        {
            let outer = self.depth.saturating_sub(1);
            self.layers
                .retain(|binding| binding.depth != self.depth || !binding.is_let);
            for binding in &mut self.layers {
                if binding.depth == self.depth {
                    binding.depth = outer;
                }
            }
        }
        if self.depth > 0 {
            self.depth -= 1;
        }
        self.layers.retain(|binding| binding.depth <= self.depth);
        while self
            .conds
            .last()
            .is_some_and(|cond| cond.depth > self.depth)
        {
            let cond = self.conds.pop().expect("cond");
            self.finish_cond(prefix, index, cond);
        }
        index + 1
    }

    fn finish_cond(&mut self, prefix: &str, close: usize, cond: Cond) {
        if cond.else_arm.is_none() && else_follows(prefix, close + 1) {
            self.pending_else = Some(PendingElse {
                entry: cond.entry.clone(),
                if_exit: self.layers.clone(),
            });
            self.layers = cond.entry;
            return;
        }
        self.layers = match cond.else_arm {
            Some(if_exit) => merge_both(&cond.entry, &if_exit, &self.layers),
            None => merge_partial(&cond.entry, &self.layers),
        };
    }

    fn on_binding(&mut self, prefix: &str, name: &str, index: usize) -> usize {
        let Some(noted) = note_binding(prefix, index, name, self.visible().as_deref()) else {
            return index + 1;
        };
        self.place(noted.is_let, noted.url);
        noted.end.max(index + 1)
    }

    fn place(&mut self, is_let: bool, url: String) {
        if is_let {
            if self
                .layers
                .last()
                .is_some_and(|binding| binding.depth == self.depth)
            {
                self.layers.pop();
            }
            self.layers.push(UrlBinding {
                depth: self.depth,
                url,
                is_let: true,
            });
            return;
        }
        if let Some(binding) = self.layers.last_mut() {
            binding.url = url;
            return;
        }
        self.layers.push(UrlBinding {
            depth: self.depth,
            url,
            is_let: false,
        });
    }
}

#[path = "bind_probes.rs"]
#[cfg(test)]
mod probes;
