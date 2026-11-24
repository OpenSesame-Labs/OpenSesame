#!/usr/bin/env python3
"""Create intentional broken copies of the reviewed replay implementation."""
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text()
target = Path(sys.argv[2])
cases = {
    "expiry-boundary": (
        "*retain_until >= now",
        "*retain_until > now",
    ),
    "proof-window": (
        "now.saturating_add(ttl_secs).max(valid_until)",
        "now.saturating_add(ttl_secs)",
    ),
    "duplicate-check": (
        "if seen.contains_key(jti) {",
        "if false && seen.contains_key(jti) {",
    ),
    "capacity-check": (
        "if seen.len() >= capacity {",
        "if seen.len() > capacity {",
    ),
    "empty-jti": (
        "if jti.is_empty() {",
        "if false && jti.is_empty() {",
    ),
    "oversized-jti": (
        "if jti.len() > MAX_JTI_LEN {",
        "if false && jti.len() > MAX_JTI_LEN {",
    ),
    "age-boundary": (
        "is_some_and(|age| age <= max_age_secs)",
        "is_some_and(|age| age < max_age_secs)",
    ),
    "short-replay-deadline": (
        "iat.saturating_add(max_age_secs)",
        "iat.saturating_add(max_age_secs).saturating_sub(1)",
    ),
}
for name, (before, after) in cases.items():
    if source.count(before) != 1:
        raise SystemExit(f"{name}: expected exactly one mutation target")
    (target / f"{name}.rs").write_text(source.replace(before, after, 1))
