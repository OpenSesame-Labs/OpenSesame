# ADR 0227 — Fail closed on ambiguous SPIFFE snapshots

- **Status:** Accepted
- **Date:** 2026-11-16
- **Amends:** [ADR 0132](0132-optional-mtls-and-workload-identity.md) §12
- **Formal model:** [SPIFFE withdrawal and outage policy](../../spec/formal/spiffe/README.md)

## Context

ADR 0132 makes each Workload API snapshot a replacement: an omitted identity
or trust bundle must stop authorizing, while a rejected malformed candidate may
leave a prior generation usable within its bounds. The SPIFFE SDK validates a
whole response before returning a context. If one SVID is malformed, it does
not expose enough of the response to determine whether the configured SVID or
its trust was omitted. Its missing-bundle error also does not name the affected
SVID. Retaining the previous generation after such an error could therefore
keep authorizing an identity or trust the new snapshot removed.

Even after the SDK parses a response, the selected SVID can fail profile checks
or the generation sink can reject it. Retaining the prior generation in that
case can preserve a removed foreign domain or a removed CA inside a domain
that remains present.

## Decision

- Withdraw the current generation on SDK-level unparseable snapshots, empty
  SVID lists, missing required bundles, and explicit `PERMISSION_DENIED` or
  `UNAUTHENTICATED` statuses on the material RPC, whether returned at opening
  or while streaming. Report an unparseable snapshot as malformed rather than
  claiming a particular identity was definitely absent.
- Treat connection failures, `UNAVAILABLE` and EOF as transient outages. Keep
  the existing jittered reconnect behavior and retain a generation no later
  than its certificate expiry or original outage freshness deadline. Opening a
  stream or rejecting a candidate does not reset that deadline.
- For a successfully parsed snapshot whose selected candidate is rejected by
  the profile or sink, retain the previous generation only when the snapshot's
  validated trust view contains every prior anchor in the same domain. A
  missing or malformed trust view withdraws the whole generation. An added
  anchor does not itself make retaining the narrower old trust unsafe.
- A withdrawn source remains withdrawn across retries and rejected candidates;
  only a successfully activated snapshot restores it. The reported credential
  status becomes expired at the earlier effective deadline, including equality.

## Consequences and limits

An unrelated malformed SVID, an unattributed missing bundle, a refused
candidate that removed trust, or an authentication/permission denial can
interrupt an otherwise usable identity. This availability cost is intentional:
the SDK does not expose enough information to establish that keeping the old
generation would respect snapshot replacement. A valid later snapshot restores
service. The policy does not treat arbitrary transport failures as revocation.

The SDK's error mapping and the lockfile's resolved SDK package are part of the
reviewed boundary. Tests exercise the fake gRPC Workload API, including errors
at stream opening and during a stream. A real SPIRE reference test is separate
and must be executed to support an interoperability claim.

This policy does not enforce an empty sink at source startup. A pre-populated
sink can retain its previous generation if the source never activates a new
one. The current gateway creates an empty manager and waits for activation
before binding its listener; callers of the public source API must not assume
that it quarantines an existing generation.

The source converts a UTC deadline to a relative Tokio sleep. Its prompt
withdrawal claim assumes the wall clock does not jump forward across the
deadline while that sleep is armed and that the task is scheduled in time.
`SourceStatus::credential_status` independently checks the supplied current
wall time, but the generation sink is not proven to recheck the source's
freshness deadline on every use. This ADR does not claim a hard real-time or
clock-jump-safe sink guarantee.

The Lean model proves properties of an abstract policy, not a refinement proof
of the SDK, the concurrent Rust source, certificate verification, or sink
consumers. Finite correspondence vectors and synthetic integration tests are
separate evidence, not substitutes for those proofs.
