//! Pure URL and entry-name matching for password-manager bridges.

use opensesame_sealed_store::Entry;

/// May the name heuristic hand `entry` to `host`? Only when the entry names
/// no URL of its own, or one of its URLs really serves `host`: an explicit
/// `url: https://github.com` is never overridden by a path that happens to
/// look like `github.lol`.
#[must_use]
pub fn name_fallback_admits(entry: &Entry, host: &str) -> bool {
    trailer_urls(&entry.trailer).is_empty() || entry_matches_host(entry, host)
}

pub(crate) fn entry_matches_host(entry: &Entry, host: &str) -> bool {
    trailer_urls(&entry.trailer)
        .iter()
        .filter_map(|url| host_of(url))
        .any(|candidate| host_matches(&candidate, host))
}

/// Read a `key: value` trailer field, first match wins, case-insensitive key.
#[must_use]
pub fn trailer_value(trailer: &str, keys: &[&str]) -> Option<String> {
    for line in trailer.lines() {
        let Some((raw_key, value)) = line.split_once(':') else {
            continue;
        };
        let raw_key = raw_key.trim().to_ascii_lowercase();
        if keys.iter().any(|k| *k == raw_key) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Every URL-ish trailer line, in file order.
#[must_use]
pub fn trailer_urls(trailer: &str) -> Vec<String> {
    const KEYS: [&str; 5] = ["url", "uri", "website", "site", "location"];
    let mut out = Vec::new();
    for line in trailer.lines() {
        let Some((raw_key, value)) = line.split_once(':') else {
            continue;
        };
        let key = raw_key.trim().to_ascii_lowercase();
        if KEYS.contains(&key.as_str()) {
            let value = value.trim();
            if !value.is_empty() {
                out.push(value.to_string());
            }
        }
    }
    out
}

/// Extract a lowercase host from a URL, a bare authority, or a bare hostname.
///
/// Hand-rolled rather than pulling the `url` crate in: the bridges need a
/// host and nothing else, and the dependency budget argument for this crate
/// is that its dep set stays small and auditable.
#[must_use]
pub fn host_of(url: &str) -> Option<String> {
    let raw = url.trim();
    if raw.is_empty() {
        return None;
    }
    let rest = match raw.find("://") {
        Some(idx) => &raw[idx + 3..],
        None => raw,
    };
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .filter(|s| !s.is_empty())?;
    let authority = match authority.rsplit_once('@') {
        Some((_, host)) => host,
        None => authority,
    };
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        stripped.split(']').next()?
    } else {
        authority.split(':').next()?
    };
    let host = host.trim().trim_end_matches('.');
    if host.is_empty() {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

fn strip_www(host: &str) -> &str {
    host.strip_prefix("www.").unwrap_or(host)
}

/// Does a stored URL's host serve the queried host?
///
/// Exact match, or either side is a subdomain of the other (an entry filed
/// under `example.com` covers `login.example.com`, and vice versa). `www.` is
/// ignored on both sides, matching what every password manager does.
#[must_use]
pub fn host_matches(entry_host: &str, query_host: &str) -> bool {
    let a = strip_www(&entry_host.to_ascii_lowercase()).to_string();
    let b = strip_www(&query_host.to_ascii_lowercase()).to_string();
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a == b || a.ends_with(&format!(".{b}")) || b.ends_with(&format!(".{a}"))
}

/// Path-name heuristics: does an entry's logical path look like it belongs to
/// `query_host`? Only reached when no `url:` trailer matched.
///
/// A segment must *be* the host, or a parent/child of it on a dot boundary.
/// There is deliberately no bare-label rule (`Dev/github` answering
/// `github.com`): it would equally answer `github.lol` or
/// `attacker.github.io`, handing a credential to a lookalike or a
/// shared-hosting tenant.
#[must_use]
pub fn name_matches(name: &str, query_host: &str) -> bool {
    let host = strip_www(&query_host.to_ascii_lowercase()).to_string();
    if host.is_empty() {
        return false;
    }
    for segment in name.split('/') {
        let segment = strip_www(&segment.trim().to_ascii_lowercase()).to_string();
        if segment.is_empty() {
            continue;
        }
        if segment == host {
            return true;
        }
        // Both directions require the other side to look like a real domain;
        // otherwise a one-label query such as `com` matches every `*.com`.
        if segment.contains('.') && host.ends_with(&format!(".{segment}")) {
            return true;
        }
        if host.contains('.') && segment.ends_with(&format!(".{host}")) {
            return true;
        }
    }
    false
}
