# Formal authentication and authorization verification

This register connects security requirements to their implementation, formal
model, and checks. The present Lean coverage consists of bounded slices of the Identity API and Host. It is not a
proof of OpenSesame's complete authentication or authorization system. Update this register whenever the covered behavior changes or a new
formal property is introduced.

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
The hashes detect drift. They do not prove the review or the model is correct.
The pre-push hook selects registered suites when their mapped implementation
files occur in the commits being pushed, including changes later reverted. For
a suite with a registered Cargo.lock projection, it also selects changes to the
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
| Interaction deadline admission. [ADR 0086](../adr/0086-wallet-native-interaction-layer.md). | [`interaction-clock.ts`](../../packages/control-plane/src/services/interaction-clock.ts) and the approval and consumption routes. | [CLOCK-1](../../spec/formal/interaction-clock/README.md) proves the sampled deadline predicate. The real-route tests cover selected pauses; commit-time expiry, atomic storage, and rollback are not proved. |
| DPoP replay cache. RFC 9449. | [`replay.rs`](../../crates/proof/src/replay.rs). | [DPOP-R1](../../spec/formal/dpop/README.md) models the single-process cache under stated clock and atomicity assumptions; full DPoP validation is not proved. |
| Grant delegation and replacement. [ADR 0036](../adr/0036-coverage-guided-fuzz-and-bounded-proofs.md). | [`grant.rs`](../../crates/domain/src/grant.rs) and its validators. | [AUTH-D1–D6](../../spec/formal/authority/README.md) model selected attenuation checks. Caller authentication, all constraint dimensions, and concurrent behavior are outside the model. A separate Kani harness checks a bounded interval case. |
| SPIFFE identity and trust withdrawal. [ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md), [ADR 0223](../adr/0223-spiffe-withdrawal-under-ambiguous-snapshots.md). | [`source.rs`](../../crates/spiffe-source/src/source.rs), [`source_policy.rs`](../../crates/spiffe-source/src/source_policy.rs), and [`outage.rs`](../../crates/spiffe-source/src/outage.rs). | The [withdrawal model](../../spec/formal/spiffe/README.md) covers selected denial, trust-reduction, and outage-deadline decisions. It does not prove SDK behavior for arbitrary responses, implementation refinement, certificate verification, or hard real-time sink withdrawal. |
| Source-owned transport lifetime. [ADR 0223](../adr/0223-spiffe-withdrawal-under-ambiguous-snapshots.md). | [`source_lifetime.rs`](../../crates/transport-security/src/source_lifetime.rs), [`signing_fence.rs`](../../crates/transport-security/src/signing_fence.rs), [`source.rs`](../../crates/spiffe-source/src/source.rs), and the Host admission paths. | The [source-lifetime model](../../spec/formal/source-lifetime/README.md) covers selected owner, epoch, deadline, quarantine, and signer release checks. Dual-clock behavior, actual trust-bundle comparisons, scheduler timing, underlying TLS key operations, and restart persistence remain outside the Lean proof. |
| Host SPIFFE source trust selection. [ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md). | [`boot.rs`](../../crates/gateway/src/transport/boot.rs), [`source_trust_selection.rs`](../../crates/gateway/src/transport/source_trust_selection.rs). | The [selector model](../../spec/formal/source-trust-selection/README.md) proves a Boolean source-view/presence/kind/profile/domain policy; finite Rust correspondence and live TLS tests exercise the implementation. Restart persistence and arbitrary consumers remain unproved. |
| SPIFFE peer-domain admission. [ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md). | [`svid_profile.rs`](../../crates/transport-security/src/svid_profile.rs), [`server_conn.rs`](../../crates/transport-security/src/server_conn.rs), and [`binding.rs`](../../crates/domain/src/transport/binding.rs). | The [peer-domain model](../../spec/formal/spiffe-peer-domain/README.md) covers abstract chain, domain, profile, selector and revocation decisions. Finite correspondence and live TLS-to-service admission tests exercise selected paths; certificate parsing, cryptography, concurrency and Rust refinement are unproved. |

The session model abstracts token-prefix matching to a Boolean and does not
prove the security of token generation or storage. The model also omits
cryptography, request/session binding, actor-to-row
identity, the temporary-project owner fallback, concurrent changes between a
check and a write, database consistency, malformed runtime values, and the
correctness of external libraries. Existing browser, integration, adversarial,
compiler, fuzz, and Kani checks remain necessary in their own scopes.
