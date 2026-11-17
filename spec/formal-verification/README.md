# Formal verification: evidence and open obligations

This directory records narrowly scoped behavioral claims and their evidence. It
is a starting point for a larger verification program, not a certification of
OpenSesame, its authentication protocols, or every feature. A state machine
can span several files, and one file can contain many different behaviors.
Listing a file in the ledger does not prove the file as a whole.

```sh
npm run verify:formal-inventory
node scripts/formal/inventory.mjs --json > /tmp/opensesame-formal-inventory.json
node scripts/formal/inventory.mjs --check
node --test scripts/formal/ledger.test.mjs
```

The inventory enumerates selected source languages in the application,
package, crate, marketplace, and tool trees. It marks simple textual leads for
state, UI events, and auth-related paths and links files to ledger entries. It
does **not** discover every implicit state machine: state can be distributed,
hidden behind libraries, expressed in other languages, or omitted by the
heuristics. It excludes test and fixture paths. Use the JSON list to organize
human review, including files with no signals; do not interpret the counts as
proof coverage. The ledger check rejects missing evidence and unregistered UI
or authentication model configurations, but cannot judge whether the claims are
sufficient or whether the tests actually refine a model.

## How to add a behavior

1. Identify the real entry points, transitions, persistent state, dependencies,
   error and cancellation paths, and authority boundaries. Record the intended
   behavior and what is not included in the claim.
2. Model finite transition systems in TLA+ and check safety, liveness where
   appropriate, invalid actions, and the assumptions under which they hold.
   State bounds and fairness assumptions belong with the model. Include a
   deliberate fault or counterexample check when practical.
3. Exercise the production behavior separately with generated sequences and
   independent oracles. Test real browser and keyboard interactions when the
   claim concerns the UI, and record seeds or traces for reproduction.
4. Add implementation paths, model/config, tests, exact checked properties, and
   limits to `ledger.json`; run its structural check and the relevant runners.
   A new TLA+ configuration under `spec/ui-behavior` or
   `spec/auth-verification` must have a ledger entry.

## Authentication assurance

For an authentication standard, identify the exact standard, version and
normative requirements, and model attacker-controlled inputs, time, replay,
errors, concurrent sessions, key custody and external dependencies as relevant.
Prove the desired properties with stated assumptions, and establish how the
actual implementation refines the proved specification. A handwritten Lean
model paired with tests against TypeScript provides useful evidence, but it
does **not** prove that TypeScript refines Lean. A proof of a decision predicate
also does not prove protocol conformance, cryptographic primitives, browser URL
parsing, persistence, or third-party identity providers.

Closing that implementation gap requires an independently justified bridge,
such as verified extraction of a proved kernel into production or a verified
semantics/refinement proof for the implementation language. Protocol libraries
and the transport and cryptographic assumptions need their own evidence.
Never report a model theorem as a proof of the entire implementation or of an
authentication standard. Reject `sorry`, admitted obligations, unreviewed
axioms, skipped tools, and proof scripts that do not run in the checked build.

Priority review areas include identity and federation transactions, session
creation and revocation, passkey ceremonies, agent and host authorization,
capability consent, vault unlock/lock races, connector lifecycles, and UI
navigation. This list is a starting queue, not an exhaustive inventory.
The [authentication](../auth-verification/state-machines.md) and
[UI](../ui-behavior/state-machines.md) catalogs name concrete entry points,
candidate invariants, existing evidence and open obligations.

The model and browser runners and their exact assumptions are described in
[UI behavior](../ui-behavior/README.md). Production SDK actions must continue
to respect the application's existing consent and authorization boundaries.
