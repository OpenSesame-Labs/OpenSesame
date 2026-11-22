# Formal authentication and authorization verification

This register connects security requirements to their implementation, formal
model, and checks. The present Lean coverage consists of bounded slices of the Identity API and Host. It is not a
proof of OpenSesame's complete authentication or authorization system. Update this register whenever the covered behavior changes or a new
formal property is introduced.

This workflow draws on Lauren Tan's Pstack
[create](https://github.com/cursor/plugins/blob/main/pstack/skills/create-formal-verification-skill/SKILL.md)
and [maintain](https://github.com/cursor/plugins/blob/main/pstack/skills/maintain-formal-verification-skill/SKILL.md)
formal verification skills: map source behavior to the model, exercise negative
controls, and state the bounds of each claim as the implementation evolves.

## Checked properties

The reviewed source revision is recorded in
[`coverage.json`](../../spec/formal/auth/coverage.json), together with hashes of
the source files actually reviewed. Principal and project proof design is in
[ADR 0178](../adr/0178-authorization-checks-are-proofs-the-compiler-can-see.md).
The provisional token-prefix requirement is recorded in the
[session ID audit](audits/2026-08-07-provisional-session-id.md). The model and
theorem names below are in
[`AuthPolicy.lean`](../../spec/formal/auth/AuthPolicy.lean). The model represents
a lookup result and a role result as already obtained; it does not model their
storage or network implementations.

| ID | Requirement and implementation | Lean property | Executable correspondence |
|---|---|---|---|
| AUTH-S1 | A provisional session authenticates only for a `pst_` token mapped to a present, unexpired, unrevoked session and a present principal that is neither suspended nor closed. [`resolveProvisionalSession`](../../packages/control-plane/src/middleware/auth.ts) performs those checks. | `bad_session_prefix_denied`, `unmapped_session_denied`, `missing_session_denied`, `revoked_session_denied`, `expired_session_denied`, `missing_principal_session_denied`, `suspended_principal_session_denied`, `closed_principal_session_denied` | The actual resolver is compared with 240 combinations of the abstract guards, expiry boundary, and principal state. |
| AUTH-P1 | An absent principal is refused and a principal with `provisional` assurance is refused. [`verifiedPrincipal`](../../packages/control-plane/src/proofs/verified-principal.ts) makes both checks. | `missing_principal_denied`, `provisional_principal_denied`, `admitted_principal_not_provisional` | The actual function is compared with all eight abstract lookup/assurance cases. |
| AUTH-Z1 | A missing project, an invisible project, or a caller without a resolved role gets no project proof. [`projectAccess`](../../packages/control-plane/src/proofs/project-role.ts) calls [`isVisible` and `roleFor`](../../packages/control-plane/src/services/project-access.ts). | `absent_project_denied`, `hidden_project_denied`, `no_role_denied` | The actual functions are compared with the model across project presence, every declared state, four expiry classes, and four role results. |
| AUTH-Z2 | A member gets no admin proof; only a resolved owner can receive an owner proof. `projectAccess` creates the role-specific proof values. | `member_never_receives_admin`, `nonowner_never_receives_owner` | The same matrix checks the role and the actual proof fields and kinds. |
| AUTH-Z3 | A project at or after its expiration instant is invisible; a deleted project is invisible. `isVisible` uses an inclusive expiry check. | `not_visible_at_expiry`, `not_visible_after_expiry`, `deleted_project_not_visible` | The matrix includes times before, exactly at, and after expiry for every project state and role. |

The Lean theorems quantify over their declared model inputs. Time in the model
is an arbitrary integer. The correspondence test exercises 8 principal cases,
240 session cases, and 160 project cases at representative millisecond values,
with test stores that return the specified rows and memberships. It checks the
real TypeScript functions, but finite testing does not mathematically prove
that TypeScript refines the Lean model for all inputs. Review that mapping
whenever a covered source changes.

`verifiedPrincipal` means **non-provisional assurance** here. It admits
`self_asserted`, and this function does not check the principal's lifecycle
state. The Lean property must not be described as proving a successful login,
a particular authentication factor, or a non-suspended account.

## Reproduce and maintain

Install Lean 4.24.0 using the pinned
[`lean-toolchain`](../../spec/formal/auth/lean-toolchain) and install the
repository's Node dependencies. Then run:

```sh
npm run verify:auth-formal
```

An existing Lean executable can be selected with
`OPENSESAME_LEAN_BIN=/absolute/path/to/lean`. The command rejects another Lean
version and treats Lean warnings, including a `sorry`, as errors. Lean checks
theorems and emits the cases; Vitest compares those cases to the real functions;
finally the source-hash check fails on an unreviewed change to any covered file.
It also compares those hashes to the declared reviewed commit; the commit and
its source blobs must be present locally. Fetch the reviewed history if they
are missing. The hashes detect drift. They do not prove the review or the model
is correct.
The pre-push hook selects registered suites when their mapped implementation
files occur in the commits being pushed, including changes later reverted. The
filter uses file paths: a test-only edit inside a mapped implementation file
can still select its suite, while a separate proof-only or test-only file does
not. For a suite with a registered Cargo.lock projection, it also selects changes to the
reviewed dependency graph; lockfile-only graph selection conservatively includes
inactive optional, development, and target-specific packages. It
also selects authority for changes to its inherited Cargo workspace inputs and
relevant package overrides; its bounded projection and exclusions are described
in the [authority model](../../spec/formal/authority/README.md). The proof
harness uses a separate lockfile and does not claim complete graph equality with
the production workspace. The gate
reads historical policy as data and checks each registry or requirements change
against the requirements in that commit. Earlier registry history from before
the requirements file existed is included in selection. If a changed path had
an incoming mapping, the target must retain it and its proof files and command
from the incoming history and the relevant destination and parent snapshots.
Change a suite's proof-file mappings or command in a separate, metadata-only
push before changing an implementation mapped to it. A changed target policy must include the requirements file; unrelated
and proof-only changes do not run suites. Release qualification runs every
registered suite and checks the same policy. When adding or expanding coverage,
update [`proof-registry.json`](../../spec/formal/proof-registry.json),
[`proof-requirements.json`](../../spec/formal/proof-requirements.json), and the
independent trusted minimum in [`formal-proof-pinned-suites.mjs`](../../scripts/security/formal-proof-pinned-suites.mjs),
together with the tests and this register. The registry and requirements must
match each other and the trusted minimum on suite IDs, implementation paths,
proof files, and commands. All three require review; their agreement alone does
not establish that a proof covers an implementation. Pushes also compare changed
paths with the advertised remote main policy so stale branches cannot silently
omit its mappings. The remote must be reachable for this comparison.
If main moves while its missing history is fetched, the gate rejects the push
and asks for a retry. A local hook cannot make its last remote read atomic with
the server's eventual ref update; server-side policy remains necessary.
Selected suites require a clean worktree with no `assume-unchanged` or
`skip-worktree` index flags, so Git cannot hide proof-input changes.

For a selected suite, the hook compares its npm verification script and npm
pre/post hooks, its listed runner files, and the shared runner files with the
destination and each relevant incoming history snapshot. This detects changes
that are later reverted, including changes through a merge. New refs use the
maximal advertised ancestor tips; if there are multiple incomparable tips,
all must agree. Missing, malformed, or non-regular runner files fail closed.
The protected inputs include each suite's `required-theorems.lean` signatures;
change these separately from a mapped implementation.
The protected inventory is in
[`formal-proof-runner-pins.json`](../../scripts/security/formal-proof-runner-pins.json).
For a selected suite it is parsed as data from the committed Git blob after its
checked-out bytes are verified. An inventory-only update is parsed from the
pushed commit without selecting a proof. The checker independently includes it
in each selected history comparison, so an inventory edit cannot remove its
own protection. The hook, controller, loader, and other executable modules
imported before the check remain trusted inputs, including their import-time
effects.
Each suite row lists its npm script, required runner paths, Cargo configuration
directories, and optional execution-input paths. The array-only format rejects
duplicate suites, duplicate paths within a row, malformed rows, and unsafe paths.
The controller independently requires each pinned suite's theorem-signature
file, essential runner inputs, and applicable Cargo metadata in every incoming
inventory-changing commit and at the target. It rejects malformed or weakened
intermediate versions even when a later commit restores them. Add a new suite
and its complete inventory together in the metadata-only update.
Change a runner or this inventory in a separate metadata-only push before
changing an implementation that selects the affected suite. This also applies
when adding a suite or a new runner file; an advertised predecessor branch can
serve as the baseline for a stacked branch.

For Cargo-based suites, the comparison includes both Cargo configuration
filenames at every repository directory searched from the verifier's working
directory, including files absent from the baseline. Before a changed lockfile
or workspace manifest can be classified as unrelated, the hook checks the
relevant projection helpers and selector against their historical baseline and
their checked-out copies. Update these helpers in a separate
metadata-only push before changing an input governed by a projection.
When a suite runs, the same execution inputs must match the committed worktree,
including absent paths that Git would otherwise ignore. An unrelated push does
not run this check. Cargo configuration outside the repository remains part of
the local environment's trust boundary.

This local comparison is an incremental safeguard, not a trusted verifier or
proof that the baseline was reviewed: an earlier metadata-only push may change
the runner, and a local hook or environment can be bypassed or modified. Model
definitions, correspondence tests, and coverage manifests remain editable
alongside code and could also be weakened. Review and
server-enforced checks, with independently trusted verifier and coverage
baselines, are needed for a stronger guarantee. The runner inventory does not
pin every transitive dependency, executable, or environment input. It does not
establish that a change was reviewed, identify every Rust file that a build
can compile, or prove that the mapped source graph is complete. Review new
modules, build inputs, and conditional compilation against the stated coverage.
A suite covering a local Cargo dependency graph can register a multi-package
workspace projection. Its reviewed manifest paths, each sibling `build.rs`,
and every intermediate `Cargo.toml` path must be mapped implementation
inputs, and its lock projection must cover the entire root closure. The suite's
runner must pin reviewed build-script contents or absence and reject unreviewed
or nonregular scripts before invoking Cargo. The projector accepts only an
absent `package.build`, `false`, or the canonical `"build.rs"` path; custom
build paths fail closed. For each relevant commit and merge parent,
the gate reads regular manifest blobs from that revision, resolves local path
dependencies and aliases, and checks them against the lockfile's local closure.
The workspace projection includes inherited package fields, dependencies and
lints used by that closure, along with relevant patches and profile overrides.
An approved manifest may be absent only while it is outside the closure;
unmapped or ambiguous packages, alternate workspace roots, nested manifests,
unsupported paths and malformed dependency tables fail closed. Both current
and legacy Cargo build/dev dependency table spellings are included.

The lock graph conservatively includes optional, development and target-specific
dependencies but does not encode active features or target choice. These
projections do not establish feature unification from packages outside the
registered closure, toolchain or Cargo configuration integrity, or the behavior
of dependencies and build scripts. Each suite must document and review those
limits separately; the projection is a drift selector, not a Lean refinement
proof.

The Rust suites also independently list the Cargo library, binary, and named
integration-test targets they actually exercise. Before Cargo runs, the drift
check requires each selected name and source path to match that inventory and
its covered hash, rejects unsupported target attributes, and refuses local
build scripts or custom build paths for those packages. Unrelated inactive
targets are outside this inventory. The current push selector maps reviewed
crate manifests as whole files, however, so even an unrelated edit to one of
those manifests can select the suite. Changes to an unrelated inactive target
source are not selected merely because that target exists.

These target checks do not independently discover Rust modules, `include!`
inputs, or macro expansion. Reviewing a covered source change must also review
its wiring and update the implementation mappings for any newly relevant
source; a matching target path and source hash alone do not establish that the
transitive source inventory is complete.

The authority, SPIFFE, source-lifetime, source-trust-selection and peer-domain
Rust runners guard against Cargo reusing artifacts built from another worktree.
They assign a reviewed workspace wrapper to the canonical checkout path, clear
`RUSTC_WRAPPER` for proof subprocesses, and check the pinned inputs before and
after execution. A freshness preflight touches the declared local target roots,
including path dependencies outside the Cargo workspace, and requires active
local artifacts to be freshly compiled in the current proof session before the
test or program runs. It checks the resulting artifacts and runs the input
check again after nonzero exits and caught interruptions; a hard kill cannot
run that final check. The authority harness has its own Cargo workspace and
uses a private temporary target directory.

Mutation controls use a stable private scratch checkout for each live checkout
and hold its exclusive lock through the compiler and descendants. Cleanup only
removes the registered directory while holding that lock; if an interrupted
child still holds it, a later run waits and can retire the checkout. Explicit
cleanup uses `python3 -I scripts/security/formal-cargo-isolation.py --clean-scratch <checkout>`.
A permanently surviving descendant can therefore block later controls
indefinitely. A hard kill immediately before a staging
directory is registered can leave an empty private directory; interruption
during registration or wrapper creation can also leave small private temporary
files. Repeated hard kills can accumulate these remnants, which contain no
checked-out source or compiled artifacts. A hard
kill of an authority run can leave its private temporary target until removed.

These checks assume a trusted Cargo and Rust toolchain, reviewed runner and
Cargo configuration, and no concurrent uncooperative changes to the source or
target cache during a proof. The scratch lock requires supported POSIX locking
and no-replace rename behavior; unsupported systems fail closed. The lock and
artifact checks provide runtime evidence about the selected builds; they do not
prove that Rust refines the Lean model. Runner and Cargo configuration changes
are execution metadata, and must be protected separately rather than selecting
these implementation-filtered proofs by themselves.

The Rust drift checks load their Cargo projection helpers only after checking
the helper bytes against the suite's coverage record. The authority check also
isolates the workspace helper's nested lock-projection import. This detects
helper drift when that record is trusted; changing both requires review of the
runner metadata and is not ruled out by a hash alone.

The shared Lean checker rejects unapproved axiom
declarations and theorem dependencies; `propext` and `Quot.sound` are permitted
Lean built-ins. See [the hook instructions](../../scripts/README.md).

Each suite maintains a separate `required-theorems.lean` file containing the
required theorem names and their expected proposition types; the authentication
suite's requirements are [here](../../spec/formal/auth/required-theorems.lean).
The shared checker uses Lean's definitional equality to compare each named
theorem's full type with its recorded proposition. It rejects a missing theorem
or a replacement with an axiom or definition, and checks the expected number
of distinct obligations. The checker tests
exercise missing and weakened theorems, missing or duplicate requirements, and
unapproved axioms. These requirements refer to definitions in the model: a
change to a definition can change a proposition's meaning without changing its
recorded type. Review the model definitions, requirements, and real-code
correspondence together; these checks do not prove implementation refinement.

The initial check was exercised against separate scratch regressions in the
token prefix, session mapping, expiry, revocation, suspension and closure
checks, as well as the provisional-assurance check, member role, project state,
and project expiry boundary. Each produced a failing correspondence assertion.
The original source was restored and the check passed again. Repeat these
controls in isolated source copies with
`python3 spec/formal/auth/negative-controls.py`; see the
[negative-control instructions](../../spec/formal/auth/NEGATIVE-CONTROLS.md)
and [`verify-auth-formal` skill](../../skills/verify-auth-formal/SKILL.md).

For each new or changed security property, record a stable ID, its precise
requirement and threat, normative source, implementation symbols, assumptions,
formal theorem or model-check property, real-code evidence, review revision,
and status. Mark a property **unproved** until the relevant check has actually
run and its relationship to the implementation has been reviewed. A test, a
compiler-visible token, and a Lean theorem establish different things.

## Other authentication and authorization areas

These are existing specifications and implementation starting points, not a
claim of exhaustive inventory or Lean coverage:

| Area and source | Implementation starting point | Formal status in this register |
|---|---|---|
| Federated sign-in. [Contract](../architecture/federated-signin.md). | [`federated-pending.ts`](../../packages/control-plane/src/interactions/federated-pending.ts) and [`interactions.ts`](../../packages/control-plane/src/routes/interactions.ts). | [FED-I1–I3](../../spec/formal/oauth/README.md) model signed pending-cookie binding, legacy provenance, and matching current trust. They do not prove PKCE, redirects, tokens, or protocol compliance. |
| Interaction approval binding. [ADR 0084](../adr/0084-external-authorization-notifications.md). | [`interaction.ts`](../../packages/os-domain/src/machines/interaction.ts). | [APR-B1–B5](../../spec/formal/webauthn/README.md) model digest binding, expiry, lifecycle, and sequential consumption. WebAuthn cryptography and concurrent storage are outside the model. |
| CLI app-integration assertion origin and presence. [CLI-WA1](#cli-wa1-cli-assertion-origin-and-presence). | [`webauthn_assertion.rs`](../../crates/cli-app-integration/src/webauthn_assertion.rs), called for registration and approval. | Unproved; separate from APR-B1–B5. |
| Identity listener trust rotation. [Operator mTLS doc](../operators/mtls.md). | [`listener.ts`](../../packages/control-plane/src/transport/listener.ts), [`request-evidence.ts`](../../packages/control-plane/src/transport/request-evidence.ts). | [IDENTITY-TLS1](#identity-tls1-stale-transport-evidence-after-trust-rotation): **unproved**; Vitest regressions only. |
| CLI app-integration credential registration and retries. [CLI-WA2](#cli-wa2-cli-credential-registration-and-retries). | [`register_webauthn`](../../crates/cli-app-integration/src/pairing/binding.rs). | Unproved; separate from APR-B1–B5. |
| CLI app-integration restricted approvals. [CLI-WA3](#cli-wa3-restricted-cli-approvals). | [`ensure`](../../crates/cli-app-integration/src/lib.rs) and [`human_proof_verify`](../../crates/cli-app-integration/src/human_proof.rs). | Unproved; separate from APR-B1–B5. |
| Interaction deadline admission. [ADR 0086](../adr/0086-wallet-native-interaction-layer.md). | [`interaction-clock.ts`](../../packages/control-plane/src/services/interaction-clock.ts) and the approval and consumption routes. | [CLOCK-1](../../spec/formal/interaction-clock/README.md) proves the sampled deadline predicate. The real-route tests cover selected pauses; commit-time expiry, atomic storage, and rollback are not proved. |
| DPoP replay cache. RFC 9449. | [`replay.rs`](../../crates/proof/src/replay.rs). | [DPOP-R1](../../spec/formal/dpop/README.md) models the single-process cache under stated clock and atomicity assumptions; full DPoP validation is not proved. |
| Grant delegation and replacement. [ADR 0036](../adr/0036-coverage-guided-fuzz-and-bounded-proofs.md). | [`grant.rs`](../../crates/domain/src/grant.rs) and its validators. | [AUTH-D1–D6](../../spec/formal/authority/README.md) model selected attenuation checks. Caller authentication, all constraint dimensions, and concurrent behavior are outside the model. A separate Kani harness checks a bounded interval case. |
| Host API relay organization tenant isolation. [ADR 0046](../adr/0046-relayed-execution-and-authorization-inbox.md). | [`caller_scope`](../../crates/gateway/src/routes/relay_scope.rs) scopes inspection and denial in [`relay.rs`](../../crates/gateway/src/routes/relay.rs). | **RELAY-T1** is **unproved**. Sessions use their authenticated organization; operators use the bootstrap organization. Cross-organization inspection and denial return `not_found`. Disabled execution and result routes return 501 after authentication without disclosing tenant records. [`relay_tenant_tests.rs`](../../crates/gateway/src/routes/relay_tenant_tests.rs) exercises the boundary; the relay route suite passed before the latest main integration, and there is no Lean suite. |
| SPIFFE identity and trust withdrawal. [ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md), [ADR 0227](../adr/0227-spiffe-withdrawal-under-ambiguous-snapshots.md). | [`source.rs`](../../crates/spiffe-source/src/source.rs), [`source_policy.rs`](../../crates/spiffe-source/src/source_policy.rs), and [`outage.rs`](../../crates/spiffe-source/src/outage.rs). | The [withdrawal model](../../spec/formal/spiffe/README.md) covers selected denial, trust-reduction, and outage-deadline decisions. It does not prove SDK behavior for arbitrary responses, implementation refinement, certificate verification, or hard real-time sink withdrawal. |
| Source-owned transport lifetime. [ADR 0227](../adr/0227-spiffe-withdrawal-under-ambiguous-snapshots.md). | [`source_lifetime.rs`](../../crates/transport-security/src/source_lifetime.rs), [`signing_fence.rs`](../../crates/transport-security/src/signing_fence.rs), [`source.rs`](../../crates/spiffe-source/src/source.rs), and the Host admission paths. | The [source-lifetime model](../../spec/formal/source-lifetime/README.md) covers selected owner, epoch, deadline, quarantine, and signer release checks. Dual-clock behavior, actual trust-bundle comparisons, scheduler timing, underlying TLS key operations, and restart persistence remain outside the Lean proof. |
| Host SPIFFE source trust selection. [ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md). | [`boot.rs`](../../crates/gateway/src/transport/boot.rs), [`source_trust_selection.rs`](../../crates/gateway/src/transport/source_trust_selection.rs). | The [selector model](../../spec/formal/source-trust-selection/README.md) proves a Boolean source-view/presence/kind/profile/domain policy; finite Rust correspondence and live TLS tests exercise the implementation. Restart persistence is addressed separately by the history suite below, under its stated assumptions; arbitrary consumers remain unproved. |
| SPIFFE peer-domain admission. [ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md). | [`svid_profile.rs`](../../crates/transport-security/src/svid_profile.rs), [`server_conn.rs`](../../crates/transport-security/src/server_conn.rs), and [`binding.rs`](../../crates/domain/src/transport/binding.rs). | The [peer-domain model](../../spec/formal/spiffe-peer-domain/README.md) covers abstract chain, domain, profile, selector and revocation decisions. Finite correspondence and live TLS-to-service admission tests exercise selected paths; certificate parsing, cryptography, concurrency and Rust refinement are unproved. |
| NATS outbound trust and rotation. [ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md). | [`nats_connect.rs`](../../crates/task-bus/src/nats_connect.rs), [`nats_transport_env.rs`](../../crates/task-bus/src/nats_transport_env.rs), [`nats_rotation.rs`](../../crates/task-bus/src/nats_rotation.rs), [`client.rs`](../../crates/transport-security/src/client.rs) and [`bounded.rs`](../../crates/transport-security/src/bounded.rs). | [NATS-T1, T2, C1, D1 and R1–R4](../../spec/formal/source-trust-selection/README.md#nats-client-trust-and-rotation) model selected trust, identity, revocation configuration, downgrade, sequential rotation, one-use handshake-gate and retry-limit properties. Finite correspondence and NATS/TLS controls exercise selected paths; identity-source provenance, cryptography and Rust/concurrent refinement remain unproved. Existing sessions and explicitly reused injected material still require trusted caller management. |
| Durable Host source-trust names. [Operator procedure](../operators/source-trust-history.md). | [`source_history.rs`](../../crates/gateway/src/transport/source_history.rs), its coordinator, source flow and stored-trust lifecycle. | The [history model](../../spec/formal/source-trust-history/README.md) passed Linux process-level checks on `b1016221`; all 11 mutation controls passed across two runs after a focused PEM witness was added. The full suite and pre-push run need repetition with that witness. It does not establish fencing of noncooperating writers, store continuity, or Rust/SQLite refinement. |
| Browser-extension runner origin binding. [Extension README](../../apps/browser-extension/README.md). | [`page-fns.ts`](../../apps/browser-extension/runner/page-fns.ts) checks the document origin in every page function and `submit` before touching the DOM; [`browser.ts`](../../apps/browser-extension/runner/browser.ts), [`driver.ts`](../../apps/browser-extension/runner/driver.ts) and [`tab.ts`](../../apps/browser-extension/runner/tab.ts) settle `off_origin` as a navigation failure and refuse screenshot capture. | **EXT-O1** is **unproved**. A runner action executes only in a document whose origin equals the run's origin; after focus moves, a changed origin throws before any read or write; `stillOf` always returns `unsupported`, so no frame is captured. Vitest regressions only: [`page-fns.test.ts`](../../apps/browser-extension/runner/page-fns.test.ts), [`page-fns-dom-depth.test.ts`](../../apps/browser-extension/runner/page-fns-dom-depth.test.ts), [`browser.test.ts`](../../apps/browser-extension/runner/browser.test.ts) and [`driver-page.test.ts`](../../apps/browser-extension/runner/driver-page.test.ts); the extension suite passed 176 tests at this change. There is no Lean model; cross-frame, redirect-race and browser-engine origin semantics are outside these tests. |

The NATS check fixes the Cargo library targets and exact test inventory, but
it does not establish the full Rust module and `include!` closure. Reviewers
must map any newly introduced implementation source before later edits can
select its proof; a refreshed source hash alone is insufficient.

**RELAY-F1 — relay execution fails closed (unproved).** Until a holder can
re-authorize at the effect boundary, the Host must not accept new relay work,
deliver executable bytes, or approve execution. A relay-only or malformed-mode
delegation must not fall back to broker invocation. Previously approved result
reports must also be refused until current authority and result recording share
a durable transaction. Broker-mode offers, claims and delegated exercise are
temporarily refused because the stored mode has no independent authenticated
binding. [ADR 0046](../adr/0046-relayed-execution-and-authorization-inbox.md)
sets the intended contract. The gateway's `relay` and `intents_queue` routes and
the broker's `delegation_mode` parser and `delegation_lineage` resolver enforce the temporary restriction;
`relay_authority_tests.rs`, `relay_tenant_tests.rs`,
`intents_relay_mode_tests.rs`, and `intents_legacy_queue_tests.rs` exercise
selected boundaries, while
`delegation_mode_tests.rs` checks malformed stored offers and delegations. The focused relay, delegated-invocation, task, and broker-mode regressions passed
before the latest main integration; broker-mode regressions passed again on the
updated base. No formal theorem proves the property.
The restriction cannot recall previously disclosed requests or cancel effects
already started. Restoring relay requires a separate holder-side authority fence.

### CLI-WA1: CLI assertion origin and presence

For a CLI app-integration assertion, the signed client data must name the exact
origin bound to the pairing and must not describe a cross-origin ceremony. The
signed authenticator data must contain the SHA-256 hash of that origin's
hostname as RP ID and have both user-presence and user-verification flags set.
This applies when attaching a credential and when approving a CLI request. It
prevents accepting an otherwise valid assertion for another origin or RP, or
one missing those flags. The relevant requirements are in
[WebAuthn assertion verification](https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion)
and [authenticator data](https://www.w3.org/TR/webauthn-3/#sec-authenticator-data).

[`verify_passkey_assertion`](../../crates/cli-app-integration/src/webauthn_assertion.rs)
checks these fields along with the challenge, signature and counter. Pairing
supplies the expected origin, while Pages requests its hostname as the RP ID.
This assumes the pairing and authenticator are trustworthy: client-supplied
key material and flags do not establish authenticator provenance or hardware
attestation. The current registration requests no attestation. A client-supplied
`passkey` label is not evidence of hardware provenance.

There is no formal theorem for CLI-WA1. The signed-fixture tests in
[`webauthn_assertion_tests.rs`](../../crates/cli-app-integration/src/webauthn_assertion_tests.rs)
exercise accepted and rejected cases through registration and approval. At the
review based on `24096a75`, a direct Rust test harness passed all 62 crate
tests using existing dependency artifacts; Cargo, daemon integration and
real-browser interoperability had not yet been run for this change. Those
tests do not prove authenticator provenance.

### CLI-WA2: CLI credential registration and retries

For one live pairing bearer, a verified registration may attach a credential
only when none is attached. A subsequent verified retry must name the same
credential ID and public key and cannot lower the highest observed sign count;
a different credential requires a new operator-armed pairing. This prevents a
replayed registration from rolling back the counter and a bearer holder from
replacing an already attached key. The requirement extends the registration
boundary in [ADR 0206](../adr/0206-device-key-trust-d7-2.md); WebAuthn's
[assertion verification](https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion)
describes sign-count handling.

[`register_webauthn`](../../crates/cli-app-integration/src/pairing/binding.rs)
checks the credential identity, verifies the assertion, and updates the maximum
count while holding mutable access to the pairing store. Daemon callers hold
the same mutex used for approval and counter updates. The protection lasts only
for the in-memory pairing and does not authenticate the first key or provide
hardware attestation; counterless authenticators cannot provide clone detection
through the counter.

There is no formal theorem for CLI-WA2. Signed cases in
[`webauthn_registration_tests.rs`](../../crates/cli-app-integration/src/webauthn_registration_tests.rs)
exercise retries, rollback, replacement and re-pairing. The direct Rust harness
result and remaining integration limits are those recorded for CLI-WA1.

### IDENTITY-TLS1: stale transport evidence after trust rotation

After the Identity listener reloads client CA, originating trust, or service
bindings, established socket peer evidence and already-buffered request evidence
must not authorize new operations. Trusted ingress must not act as the originating
client when forwarded evidence is missing or invalid.

Implementation: trust generation in
[`listener.ts`](../../packages/control-plane/src/transport/listener.ts);
per-request expiry in
[`request-evidence.ts`](../../packages/control-plane/src/transport/request-evidence.ts).

Formal status: **unproved**. No Lean model or registry suite covers this
transport boundary yet.

Evidence: Vitest regressions in
[`listener-rotation.test.ts`](../../packages/control-plane/src/transport/__tests__/listener-rotation.test.ts)
(client CA, binding, originating-trust, credential-only reload, stale replay).

### CLI-WA3: restricted CLI approvals

Until authenticator provenance is established, CLI app-integration must refuse
every verb, including unknown verbs, before creating or reusing an approval
session, and reject either client-supplied proof label. This prevents a
relabeled software assertion from approving plaintext reveal or command
injection. The denied response carries a reason for newer clients while
remaining a denial to older clients. A separately authorized run grant does not
use this app-approval path.

The native and TypeScript CLI clients also refuse locally before contacting a
daemon or accepting an injected approval port. This prevents an older daemon's
`approved` response from bypassing the pause when the CLI has been updated.
An old CLI paired with an old daemon still lacks this protection until at least
one side is updated.

The pause is recorded in the
[CLI integration conformance policy](../../spec/conformance/cli-app-integration.json).
The Rust session store and proof verifier apply it; the TypeScript session
model mirrors it. Tests cover signed assertions, preexisting pending requests,
prior approved sessions, unknown verbs, an old approving daemon, injected
approval ports and the refusal message. Legacy session
lifecycle and app-approved CLI process success cases remain as dormant
requirements and are exercised again only once app approval is safely restored;
startup-template unit tests remain active. Re-enablement must invalidate
existing pairings and enroll credentials under the new trust mechanism; it must
not promote an unattested key registered during the pause. This property is unproved;
the temporary refusal must not be described as authenticator attestation. In
the `c7226a37` review, a direct Rust 1.97.1 harness passed 62 tests with one
unrelated trusted-executable fixture skipped because its executable was under
`/tmp`. The repository now pins Rust 1.99.0; Cargo and daemon integration tests
under that toolchain remain to run. The affected TypeScript tests and CLI
and app-core typechecks passed.

The session model abstracts token-prefix matching to a Boolean and does not
prove the security of token generation or storage. The model also omits
cryptography, request/session binding, actor-to-row
identity, the temporary-project owner fallback, concurrent changes between a
check and a write, database consistency, malformed runtime values, and the
correctness of external libraries. Existing browser, integration, adversarial,
compiler, fuzz, and Kani checks remain necessary in their own scopes.
