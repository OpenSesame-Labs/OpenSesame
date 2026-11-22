# opensesame-time

The maintained date/time boundary for the native workspace. It replaces direct
use of a retired dependency while preserving the timestamp text, Serde, SQLx,
leap-second, and calendar-arithmetic behavior already present on wire and at
rest. The implementation is backed by `time`; callers use only the deliberately
small compatibility surface exported here.

## Where it fits

- **Used by:** Host-domain crates, storage and SQL adapters, transport tests,
  the CLI, fuzz targets, and the vendored KeePass bridge.
- **Builds on:** `time`, `serde`, and optional SQLx database adapters. Browser
  builds use `js-sys` only for the current-time clock.
- UTC serialization remains RFC 3339 with `Z`; SQLite persistence retains the
  prior explicit `+00:00` representation and decodes legacy text, integer, and
  Julian-day rows.
- The facade intentionally does not expose local-time-zone discovery. Product
  state and protocol timestamps remain UTC or carry an explicit fixed offset.

## Surface

| Item | Role |
|---|---|
| `DateTime`, `Utc`, `FixedOffset`, `TimeZone` | Absolute timestamps and explicit offsets |
| `Duration`, `TimeDelta`, `Months` | Bounded elapsed and calendar arithmetic |
| `NaiveDateTime`, `NaiveDate` | KeePass and import-format calendar values |
| `SecondsFormat`, `Formatted` | Stable persisted and signed text formatting |

## Develop

```bash
cargo test -p opensesame-time --all-targets
cargo clippy -p opensesame-time --all-targets -- -D warnings
```

Compatibility goldens and property round trips live in
[`tests/compatibility.rs`](tests/compatibility.rs).
