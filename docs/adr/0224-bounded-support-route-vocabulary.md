# ADR 0224 — Preserve the bounded support route vocabulary

- **Status:** Accepted
- **Date:** 2026-11-17
- **Builds on:** [ADR 0088](0088-ai-native-contextual-support.md), [ADR 0166](0166-gate-help-launcher.md)

## Context

The complete optional tutorial realm now declares 42 route identifiers. The
40-route support context budget throws during development and tests, while a
production context silently loses its last two routes. Those destinations are
real pages, and the model's guide compiler accepts only the vocabulary it saw.
Omitting arbitrary routes therefore removes legitimate navigation or waits.

## Decision

Increase the per-request route budget from 40 to 48. Keep the existing
development error for authored growth beyond the budget, and keep the egress
sanitizer's independent truncation for untrusted oversized inputs. Test the
complete optional realm, require four spare entries, and verify that every
authored route survives both egress and guide vocabulary construction.

## Consequences

The current realm has six spare entries. At the existing per-entry egress
limits of 64 identifier characters and 240 title characters, the additional
eight entries can add at most 2,432 characters of identifier and title data,
plus formatting. No new fields or sources of page data are admitted. The
larger prompt and egress bound are deliberate; a future expansion still needs
review rather than silently dropping destinations.
