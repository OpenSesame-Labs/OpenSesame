# ADR 0227 — Bind first-party magic-link returns to the initiating browser

- **Status:** Accepted
- **Date:** 2026-11-17
- **Builds on:** [ADR 0057](0057-email-linking-better-auth-and-ldap.md), [ADR 0140](0140-pages-hosts-every-ceremony.md)

## Context

A first-party email sign-in previously opened an Identity endpoint that returned
a session as raw JSON and did not return the person to Pages. Redirecting that
session bearer in a URL would expose it to browser history and intermediaries.
Consuming a link as soon as it is opened also lets ordinary mail-link scanners
spend the proof before its recipient can use it.

## Decision

Pages starts a first-party email sign-in with a random state, an S256 challenge
and an allowed callback. Its verifier stays in the initiating browser. Identity
authenticates the callback context together with the one-use email proof. The
emailed link places the proof in the fragment; a confirmation page removes the
fragment from history and waits for a person to continue before POSTing it.

Identity consumes the email proof and redirects to the signed callback with a
short-lived, single-use code. That code is bound to the original challenge,
state and origin and is not itself enough to obtain a session. The initiating
tab removes the callback parameters from history and sends the code and its
verifier in a POST. Identity consumes the code atomically and returns the
session in the POST response. Durable deployments store the encrypted exchange
record in the shared security store, so different replicas cannot redeem it
twice. A failed verifier burns the code. Hosted OAuth interaction links also
wait for an explicit POST before consuming their proof, and retain their
interaction-cookie binding. Both public entry points share durable, atomic
recipient, canonical TCP-source and global send windows; stored keys are
HMAC-derived rather than cleartext. Authenticated application mail uses a
separate application/recipient budget so it cannot consume public capacity.

### Rollout

Deploy Pages with `magic-link-pkce-v1` support before deploying the Identity
route that requires it. Keep that Pages release live for at least the configured
HTML/service-worker cache lifetime, then deploy Identity. A cached older Pages
client sends neither challenge nor state; Identity answers `426` with
`client_upgrade_required`, `requiredProtocol: magic-link-pkce-v1`, and
`action: reload`, emits the structured `magic_link_client_upgrade_required`
event, sends no email, and does not charge a send budget. The response is
`Cache-Control: no-store`. The event is emitted only after origin and callback
validation, at most once per process per minute; the next emitted event includes
the number suppressed in the preceding window. This limiter is deliberately
separate from mail admission. Operators should watch that sampled signal through
the cache drain and pause the Identity rollout if it remains material. Cached
legacy Pages does not understand the JSON reload hint and shows its existing
generic HTTP 426 error, so deployment order—not the hint—is the user-facing
compatibility control. Rollback restores the newer Pages build first; it must
never restore the bearer-returning legacy exchange.

## Consequences

The callback must match an explicitly allowed CORS origin and, when configured,
the client app's base path. First-party clients without a verifier challenge are
refused rather than allowed to downgrade to the former raw-JSON completion.
The email must be opened in the browser that started sign-in; a different tab
can hand the non-secret code and state back to that browser, but cannot obtain
the verifier or bearer. An expired or lost exchange requires a new link.

The confirmation step prevents a scanner that merely opens a link from spending
it; a scanner that submits the form can still consume the proof. The fragment
is present in the emailed link before the page loads, but is not sent in the
initial HTTP request and is removed from the address bar on load. The protocol
does not claim to protect a compromised browser or mailbox.
