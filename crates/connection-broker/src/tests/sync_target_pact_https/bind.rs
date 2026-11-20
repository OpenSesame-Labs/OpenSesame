//! Bind a credentialed dispatch to the URL its builder was given.
use super::super::sync_target_pact_norm::{is_keyword_at, string_len};
use super::strip_turbofish;

#[path = "bind_tail.rs"]
mod bind_tail;

pub(super) use super::mutate::shadows;
pub(super) use bind_tail::{call_tail, ident_prefix, is_single_eq, stmt_end, strip_ref};

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
        if let Some(len) = string_len(bytes, index) {
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
        if let Some(len) = string_len(bytes, index) {
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
        });
    }
}

fn merge_partial(entry: &[UrlBinding], branch: &[UrlBinding]) -> Vec<UrlBinding> {
    if visible_url(entry) == visible_url(branch) {
        return branch.to_vec();
    }
    fail_closed(entry)
}

fn merge_both(entry: &[UrlBinding], left: &[UrlBinding], right: &[UrlBinding]) -> Vec<UrlBinding> {
    if visible_url(left) == visible_url(right) {
        return right.to_vec();
    }
    fail_closed(entry)
}

fn fail_closed(entry: &[UrlBinding]) -> Vec<UrlBinding> {
    let mut out = entry.to_vec();
    if let Some(binding) = out.last_mut() {
        binding.url.clear();
        return out;
    }
    out.push(UrlBinding {
        depth: 0,
        url: String::new(),
    });
    out
}

fn visible_url(layers: &[UrlBinding]) -> Option<&str> {
    layers.last().map(|binding| binding.url.as_str())
}

fn else_follows(source: &str, mut at: usize) -> bool {
    let bytes = source.as_bytes();
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    is_keyword_at(bytes, at, b"else")
}

fn brace_kind(source: &str, brace: usize) -> BraceKind {
    let bytes = source.as_bytes();
    let mut at = brace;
    while at > 0 && bytes[at - 1].is_ascii_whitespace() {
        at -= 1;
    }
    if at >= 2 && bytes[at - 2] == b'=' && bytes[at - 1] == b'>' {
        return BraceKind::Branch;
    }
    let header = &source[header_start(source, at)..at];
    match first_header_keyword(header) {
        Some("else") if header_has_keyword(header, "if") => BraceKind::ElseIf,
        Some("else") => BraceKind::Else,
        Some("if" | "while" | "for" | "loop" | "match") => BraceKind::Branch,
        _ => BraceKind::Block,
    }
}

fn header_start(source: &str, end: usize) -> usize {
    let bytes = source.as_bytes();
    let mut at = end;
    let mut depth = 0i32;
    while at > 0 {
        at -= 1;
        match bytes[at] {
            b')' | b']' => depth += 1,
            b'(' | b'[' if depth > 0 => depth -= 1,
            b';' | b'{' | b'}' if depth == 0 => return at + 1,
            _ => {}
        }
    }
    0
}

fn first_header_keyword(header: &str) -> Option<&str> {
    const KEYS: &[&str] = &["else", "if", "while", "for", "loop", "match"];
    let bytes = header.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        for key in KEYS {
            if is_keyword_at(bytes, index, key.as_bytes()) {
                return Some(*key);
            }
        }
        index += 1;
    }
    None
}

fn header_has_keyword(header: &str, keyword: &str) -> bool {
    let bytes = header.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if is_keyword_at(bytes, index, keyword.as_bytes()) {
            return true;
        }
        index += 1;
    }
    false
}

struct Noted {
    url: String,
    end: usize,
    is_let: bool,
}

fn note_binding(prefix: &str, index: usize, name: &str, previous: Option<&str>) -> Option<Noted> {
    let bytes = prefix.as_bytes();
    if !is_keyword_at(bytes, index, name.as_bytes()) {
        return None;
    }
    if let Some((url, end)) = super::pattern::destructured_url(prefix, index, name) {
        // `let (request,) = (client.get(evil),)` is a binding. An empty
        // URL still closes the unresolved-destination exception.
        return Some(Noted {
            url,
            end: end.max(index + 1),
            is_let: true,
        });
    }
    let eq = eq_after_name(bytes, index + name.len())?;
    let end = stmt_end(bytes, eq + 1);
    let url = rhs_url(prefix, name, eq, end, previous)?;
    Some(Noted {
        url,
        end: end.max(index + 1),
        is_let: binding_introduced_by_let(prefix, index),
    })
}

fn rhs_url(
    prefix: &str,
    name: &str,
    eq: usize,
    end: usize,
    previous: Option<&str>,
) -> Option<String> {
    let rhs = &prefix[eq + 1..end];
    if let Some(url) = builder_url(rhs) {
        return Some(url.to_string());
    }
    // `request = other` supersedes a prior URL. `request = request.json(&body)`
    // keeps it: the chain root is still that binding.
    if ident_prefix(rhs.trim()) == name {
        return previous.map(str::to_string);
    }
    Some(String::new())
}

fn binding_introduced_by_let(prefix: &str, name_at: usize) -> bool {
    let before = strip_trailing_mut(prefix[..name_at].trim_end());
    ends_with_keyword(before, "let")
}

fn strip_trailing_mut(before: &str) -> &str {
    let Some(rest) = before.strip_suffix("mut") else {
        return before;
    };
    if rest
        .chars()
        .next_back()
        .is_some_and(|ch| super::is_ident_char(ch))
    {
        return before;
    }
    rest.trim_end()
}

fn ends_with_keyword(source: &str, keyword: &str) -> bool {
    source.strip_suffix(keyword).is_some_and(|rest| {
        rest.chars()
            .next_back()
            .is_none_or(|ch| !super::is_ident_char(ch))
    })
}

/// `=` after `name`, skipping a type ascription (`let request: T =`).
pub(super) fn eq_after_name(bytes: &[u8], mut at: usize) -> Option<usize> {
    if bytes.get(at) == Some(&b':') && bytes.get(at + 1) != Some(&b':') {
        at = skip_ascription(bytes, at + 1);
    }
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    is_single_eq(bytes, at).then_some(at)
}

pub(super) fn builder_url(expr: &str) -> Option<&str> {
    marked_url(expr).or_else(|| call_arg_url(expr))
}

fn marked_url(expr: &str) -> Option<&str> {
    let bytes = expr.as_bytes();
    let mut index = 0usize;
    // Disagreeing branch URLs and unproven marks (`url.clone()`, `url,`) fail closed.
    let mut found: Option<&str> = None;
    let mut bad = false;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if let Some(at_paren) = builder_paren(expr, index) {
            let url = call_inside(&expr[at_paren..])
                .and_then(|inner| plain_ident(strip_ref(split_arg(inner, false))));
            bad |= !note_mark(&mut found, url);
        }
        index += 1;
    }
    if bad {
        Some("")
    } else {
        found
    }
}

/// `.get::<T>(` / `::request::<T>(`. A longer ident (`.get_mut`) is not a builder.
fn builder_paren(expr: &str, index: usize) -> Option<usize> {
    const METHODS: &[&str] = &["request", "get", "post", "put", "patch", "delete", "head"];
    let rest = &expr[index..];
    let sep = if rest.starts_with('.') {
        1
    } else if rest.starts_with("::") {
        2
    } else {
        return None;
    };
    let after_sep = &rest[sep..];
    let method = METHODS
        .iter()
        .copied()
        .find(|method| after_sep.starts_with(method))?;
    let method_end = index + sep + method.len();
    if expr
        .as_bytes()
        .get(method_end)
        .is_some_and(|byte| super::is_ident_byte(*byte))
    {
        return None;
    }
    let tail = &expr[method_end..];
    let after = strip_turbofish(tail).unwrap_or(tail);
    if !after.starts_with('(') {
        return None;
    }
    Some(method_end + (tail.len() - after.len()))
}

/// `false` when this mark disagrees with a URL already seen, or is unproven.
fn note_mark<'a>(found: &mut Option<&'a str>, url: Option<&'a str>) -> bool {
    match (*found, url) {
        (_, None) => false,
        (None, Some(url)) => {
            *found = Some(url);
            true
        }
        (Some(prev), Some(url)) => prev == url,
    }
}

/// Last plain-ident argument of a free function call (`build_request(other)`).
/// Method calls (`.json(&body)`) do not choose the URL.
fn call_arg_url(expr: &str) -> Option<&str> {
    let bytes = expr.as_bytes();
    let mut index = 0usize;
    let mut found = None;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        if let Some(url) = free_call_url(expr, index) {
            found = Some(url);
        }
        index += 1;
    }
    found
}

fn free_call_url(expr: &str, index: usize) -> Option<&str> {
    if expr.as_bytes().get(index) != Some(&b'(') || !is_free_call(expr, index) {
        return None;
    }
    let inner = call_inside(&expr[index..])?;
    if call_arg_count(inner) != 1 {
        return None;
    }
    plain_ident(strip_ref(split_arg(inner, false)))
}

fn call_arg_count(args: &str) -> usize {
    let bytes = args.as_bytes();
    let (mut depth, mut index, mut start, mut count) = (0i32, 0usize, 0usize, 1usize);
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' if depth > 0 => depth -= 1,
            b',' if depth == 0 => {
                if !args[start..index].trim().is_empty() {
                    count += 1;
                }
                start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    if args[start..].trim().is_empty() && count > 1 {
        count -= 1;
    }
    count
}

fn is_free_call(expr: &str, paren: usize) -> bool {
    let bytes = expr.as_bytes();
    if paren == 0 || !super::is_ident_byte(bytes[paren - 1]) {
        return false;
    }
    let mut start = paren;
    while start > 0 && super::is_ident_byte(bytes[start - 1]) {
        start -= 1;
    }
    start == 0 || bytes[start - 1] != b'.'
}

pub(super) fn skip_ascription(bytes: &[u8], start: usize) -> usize {
    let mut depth = 0i32;
    let mut index = start;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' if depth > 0 => depth -= 1,
            b'=' | b',' | b';' if depth == 0 => return index,
            _ => {}
        }
        index += 1;
    }
    index
}

fn head_args(rest: &str) -> Option<&str> {
    const HEADS: &[&str] = &["::execute", "::send", ".execute", ".send"];
    let head = HEADS.iter().copied().find(|head| rest.starts_with(head))?;
    let after = strip_turbofish(&rest[head.len()..]).unwrap_or(&rest[head.len()..]);
    call_inside(after)
}

pub(super) fn call_inside(at_paren: &str) -> Option<&str> {
    let bytes = at_paren.strip_prefix('(')?.as_bytes();
    let mut depth = 1i32;
    let mut index = 0usize;
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
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

pub(super) fn split_arg(args: &str, first: bool) -> &str {
    let bytes = args.as_bytes();
    let (mut depth, mut index, mut start) = (0i32, 0usize, 0usize);
    while index < bytes.len() {
        if let Some(len) = string_len(bytes, index) {
            index += len;
            continue;
        }
        match bytes[index] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' if depth > 0 => depth -= 1,
            b',' if depth == 0 => {
                if first {
                    return args[..index].trim();
                }
                start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    args[start..].trim()
}

pub(super) fn plain_ident(expr: &str) -> Option<&str> {
    let name = ident_prefix(expr);
    (name.len() == expr.len() && !name.is_empty()).then_some(name)
}

fn plain_receiver(expr: &str) -> Option<&str> {
    let mut expr = expr.trim();
    while let Some(inner) = expr
        .strip_prefix('(')
        .and_then(|rest| rest.strip_suffix(')'))
    {
        expr = inner.trim();
    }
    let expr = expr.strip_prefix("&mut ").unwrap_or(expr);
    plain_ident(expr.strip_prefix('&').unwrap_or(expr).trim())
}

#[path = "bind_probes.rs"]
#[cfg(test)]
mod probes;
