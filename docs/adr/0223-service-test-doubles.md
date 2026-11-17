# ADR 0223 — Test services at their real boundaries

- **Status:** Accepted
- **Date:** 2026-11-17
- **Builds on:** [ADR 0008](0008-better-auth-oidc-provider.md), [ADR 0010](0010-postgres-authoritative-store.md), [ADR 0132](0132-optional-mtls-and-workload-identity.md)
- **Operating guide:** [Service test doubles](../validation/service-test-doubles.md)

## Context

Consumers need repeatable local counterparts for services and for failures
that are difficult to arrange on demand. A single simulated cloud would be
expensive to maintain and could make tests pass while bypassing the security
properties they are meant to exercise. The repository already has useful
in-memory stores, local protocol counterparts and real-service fixtures.

## Decision

1. Make a double for an I/O boundary when it lets another component test a
   meaningful behavior. Use the same interface as the production dependency:
   an existing TypeScript port or transport, a Rust trait, or the documented
   wire protocol. Pure functions and data-only packages should normally be
   tested directly; a fake of each package is not a goal.
2. Keep test controls explicit and opt-in, with fresh per-test state and
   cleanup. TypeScript test services implement the small structural
   `TestResource` lifecycle when they hold resources; Rust testkits use their
   crate's existing trait and opt-in feature where appropriate. Lifecycle is
   shared, but unrelated business APIs are not forced into one interface.
3. Name the fidelity honestly. A scripted stub is not a service emulator;
   an in-memory implementation may differ in transactions, timing or
   durability. Document the supported operations and failures, known gaps,
   and the real-service checks still required. Unknown stub calls must fail
   rather than silently reach a real network or invent a successful response.
4. Protocol or schema generation may supply types, routing and example data,
   but cannot establish service behavior. Check generated artifacts for drift
   using their source specification and generator version, review changes, and
   maintain behavioral contract tests against both implementations where
   practical. Never generate authentication or authorization success as a
   substitute for verification.
5. Identity tests use actual verification and isolated keys and sessions where
   the fixture supports them. Local IdPs are useful, but a successful fake
   login does not prove provider interoperability, passkey hardware, TLS,
   production configuration, or authorization. Keep real integration and
   adversarial tests for those properties.

## Consequences

Consumers get fast and controlled tests without an unnecessary fake for each
pure package. More than one test layer remains necessary: a local double must
be maintained with its boundary and cannot certify the behavior it omits.
Existing coverage and known gaps are recorded in the operating guide rather
than represented as a claim that every service has a complete emulator.
