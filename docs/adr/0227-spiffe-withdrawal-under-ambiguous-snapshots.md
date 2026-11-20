# ADR 0223 — Fail closed on ambiguous SPIFFE snapshots

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

The source now claims its generation sink and quarantines prior material
before starting its task. The manager binds updates and retirement to that
owner and source epoch. It checks wall and monotonic bounds after the source
observes an outage, before and after TLS signing, at post-handshake and request-admission boundaries. Ordinary
trust updates must preserve source-owned profiles, including profiles previously
removed during the manager's lifetime; operators can remove a conflicting stored
profile without replacing source trust. The separate
[source-lifetime model](../../spec/formal/source-lifetime/README.md) records the
modeled properties, implementation evidence, and limits.

The outage interval starts when the source task observes a failure, not when a
physical disconnect that it has not yet observed occurred. Initial certificate
deadline conversion assumes a correct wall clock. `std::time::Instant` need not
advance while a machine is suspended, so rollback across suspend can extend
real elapsed retention. The signing fence withholds a signature if the
post-signing check observes expiry or rotation, but cannot cancel an in-flight
key operation. Scheduling can delay a key operation until after expiry or a
signature's transmission until after the last check. Source-owned listeners
disable session resumption so those handshakes use the signing fence. Earlier
ordinary configs retain resumption while current, but their session stores
check the generation before and after retrieval. A claim just after retrieval
can still race a resumed handshake; the post-handshake check rejects it before
application admission. Standalone client or server
configs have no such manager binding. Operations
already admitted cannot be rolled back. Source-owned trust tombstones live in
the manager; they are not persisted across restart. A caller with an owner
capability is trusted to provide fresh Workload API material. These checks do
not claim hard real-time scheduling, every form of clock-jump safety, or
unforgeable provenance for arbitrary callers of the public manager API.

The Lean model proves properties of an abstract policy, not a refinement proof
of the SDK, the concurrent Rust source, certificate verification, or sink
consumers. Finite correspondence vectors and synthetic integration tests are
separate evidence, not substitutes for those proofs.
