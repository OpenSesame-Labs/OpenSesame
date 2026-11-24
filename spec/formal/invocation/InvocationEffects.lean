/-! INV-O1, INV-O2, INV-D1 and INV-D2, continuing `Invocation.lean`.

Each family is a transcription of named Rust guards; the vectors printed by
`main` are replayed against that Rust code by the harnesses `verify.sh` runs.
Strings, digests and signatures are abstracted to whether they match; SHA-256
and HMAC are assumed collision resistant, Ed25519 unforgeable. -/

namespace OpenSesame.InvocationEffects

/-! INV-O1. `execute_authorized` (crates/broker/src/lib.rs) and
`execute_frozen_authorized` (crates/broker/src/frozen.rs) map the provider
result to Succeeded/Failed, then keep it only when the host discloses
outcomes: `invoke` and frozen dispatch ask `permits_outcome_disclosure`
(crates/connector-host/src/builtin_connector.rs, the inert builtin mock only);
`invoke_with_bound` (independent_executor.rs) passes `false`.
`finish_receipt` and `finish_frozen_receipt` set the summary and both external
digests to `None`, whatever the provider returned. -/

inductive Path where
  | invoke | independent | frozen
  deriving DecidableEq, Repr

inductive Connector where
  | hostMock | registered
  deriving DecidableEq, Repr

inductive Provider where
  | ok | notOk | error
  deriving DecidableEq, Repr

inductive Outcome where
  | succeeded | failed | indeterminate
  deriving DecidableEq, Repr

/-- The provider-reachable receipt fields: outcome, summary, request and
response digests (`true` = the field is present). -/
structure Receipt where
  outcome : Outcome
  summary : Bool
  requestDigest : Bool
  responseDigest : Bool
  deriving DecidableEq, Repr

def providerOutcome : Provider → Outcome
  | .ok => .succeeded
  | .notOk | .error => .failed

def discloses : Path → Connector → Bool
  | .independent, _ => false
  | _, c => c == .hostMock

def receipt (path : Path) (c : Connector) (p : Provider) : Receipt :=
  { outcome := if discloses path c then providerOutcome p else .indeterminate,
    summary := false, requestDigest := false, responseDigest := false }

theorem o1_receipt_has_no_provider_fields (path : Path) (c : Connector) (p : Provider) :
    (receipt path c p).summary = false ∧ (receipt path c p).requestDigest = false ∧
      (receipt path c p).responseDigest = false := by
  simp [receipt]

theorem o1_outcome_only_from_host_mock (path : Path) (c : Connector) (p : Provider)
    (h : (receipt path c p).outcome ≠ .indeterminate) :
    c = .hostMock ∧ path ≠ .independent := by
  cases path <;> cases c <;> cases p <;> simp_all [receipt, discloses, providerOutcome]

theorem o1_withheld_receipt_ignores_provider (path : Path) (c : Connector) (p q : Provider)
    (h : discloses path c = false) : receipt path c p = receipt path c q := by
  simp [receipt, h]

/-! Receipt schema gate shared by INV-O1 and INV-O2: `has_opaque_result` and
`assert_schema_invariants` (crates/domain/src/receipt.rs), enforced by
`sign_receipt` and `verify_receipt` (crates/audit/src/lib.rs). -/

inductive Schema where
  | legacy | v6
  deriving DecidableEq, Repr

/-- Provider-shaped content a receipt might carry; `plainDigest` is an intent
digest that is not a `sha256:` commitment. -/
inductive Leak where
  | none | summary | requestDigest | responseDigest | plainDigest
  deriving DecidableEq, Repr

inductive Key where
  | active | other
  deriving DecidableEq, Repr

def isOpaque (s : Schema) (l : Leak) : Bool := s == .v6 && l == .none

def signs (s : Schema) (l : Leak) : Bool := s == .legacy || isOpaque s l

/-- `open_receipt_intent`: verify under this signer (key, signature, schema
invariants), then require an opaque result. `tampered` alters a signed field. -/
def opens (s : Schema) (l : Leak) (k : Key) (tampered : Bool) : Bool :=
  signs s l && k == .active && !tampered && isOpaque s l

theorem o1_schema6_signing_refuses_provider_fields (l : Leak)
    (h : signs .v6 l = true) : l = .none := by
  cases l <;> simp_all [signs, isOpaque]

theorem o2_opening_only_for_verified_opaque_receipt (s : Schema) (l : Leak) (k : Key)
    (tampered : Bool) (h : opens s l k tampered = true) :
    s = .v6 ∧ l = .none ∧ k = .active ∧ tampered = false := by
  cases s <;> cases l <;> cases k <;> cases tampered <;> simp_all [opens, signs, isOpaque]

/-! INV-O2. `verifies_intent_opening` recomputes `receipt_intent_commitment`
and compares it with the receipt's `intent_digest`; it never verifies the
signature. Under collision resistance only the receipt's own opening and the
original intent digest reproduce the commitment. -/

inductive Opening where
  | own | otherInvocation | malformed
  deriving DecidableEq, Repr

inductive Digest where
  | original | other | malformed
  deriving DecidableEq, Repr

def verifiesOpening (s : Schema) (o : Opening) (d : Digest) : Bool :=
  s == .v6 && o == .own && d == .original

theorem o2_commitment_opens_only_original (s : Schema) (o : Opening) (d : Digest) :
    verifiesOpening s o d = true ↔ s = .v6 ∧ o = .own ∧ d = .original := by
  cases s <;> cases o <;> cases d <;> simp [verifiesOpening]

/-! INV-D1. `HostRuntime::invoke_bound` and `invoke_request`
(crates/connector-host/src/invocation_dispatch.rs) with
`InvocationBinding::assert_request` and `from_snapshot`
(crates/connector-host/src/invocation_binding.rs). -/

/-- Which single field of the dispatched request differs from the binding. -/
inductive Change where
  | exact | policyId | connectionRef | operation | authorizedOperation | resource
  | audience | level | parametersDigest | parameters
  deriving DecidableEq, Repr

inductive Call where
  | bound | unbound
  deriving DecidableEq, Repr

inductive Dispatch where
  | hostMock | connector | mismatch | delegatedRefused
  deriving DecidableEq, Repr

def dispatch (call : Call) (change : Change) (delegated : Bool) (c : Connector) : Dispatch :=
  match call with
  | .unbound => .mismatch
  | .bound =>
    if change != .exact then .mismatch
    else if delegated && c != .hostMock then .delegatedRefused
    else if c == .hostMock then .hostMock
    else .connector

theorem d1_dispatch_requires_the_captured_request (call : Call) (change : Change)
    (delegated : Bool) (c : Connector) (h : dispatch call change delegated c = .connector ∨
      dispatch call change delegated c = .hostMock) :
    call = .bound ∧ change = .exact := by
  cases call <;> cases change <;> cases delegated <;> cases c <;> simp_all [dispatch]

theorem d1_delegated_never_reaches_a_registered_connector (call : Call) (change : Change) :
    dispatch call change true .registered ≠ .connector := by
  cases call <;> cases change <;> simp [dispatch]

theorem d1_unbound_invoke_never_dispatches (change : Change) (delegated : Bool) (c : Connector) :
    dispatch .unbound change delegated c = .mismatch := rfl

/-- Which single input of `from_snapshot` is inconsistent. -/
inductive Capture where
  | consistent | organization | principal | connection | subject | policyId
  | lineage | chain
  deriving DecidableEq, Repr

def captures (v : Capture) : Bool := v == .consistent

theorem d1_binding_refuses_inconsistent_authority (v : Capture) :
    captures v = true ↔ v = .consistent := by
  cases v <;> simp [captures]

/-! INV-D2. `authorized_json_for_owner` and `authorized_http_for_owner`
(crates/connection-broker/src/egress_json.rs), then `authorized_http_for_row`. -/

inductive GrantConnection where
  | same | absent | other
  deriving DecidableEq, Repr

inductive RowStatus where
  | active | revoked | needsReauth
  deriving DecidableEq, Repr

structure Egress where
  providerGiven : Bool
  providerMatches : Bool
  ownerGiven : Bool
  ownerMatches : Bool
  grantOrganization : Bool
  grantConnection : GrantConnection
  rootGrant : Bool
  shallowGrant : Bool
  grantActive : Bool
  stored : Bool
  row : RowStatus
  urlAllowed : Bool
  deriving DecidableEq, Repr

inductive EgressResult where
  | sent | notFound | revoked | needsReauth | refused
  deriving DecidableEq, Repr

def egress (e : Egress) : EgressResult :=
  if !e.providerGiven || !e.ownerGiven || !e.providerMatches || !e.ownerMatches ||
      !e.grantOrganization || e.grantConnection != .same || !e.rootGrant ||
      !e.shallowGrant || !e.grantActive then .notFound
  else if !e.stored then .notFound
  else match e.row with
    | .revoked => .revoked
    | .needsReauth => .needsReauth
    | .active => if e.urlAllowed then .sent else .refused

theorem d2_egress_requires_owner_row_and_active_root_grant (e : Egress)
    (h : egress e = .sent) :
    e.providerMatches ∧ e.ownerMatches ∧ e.grantOrganization ∧ e.grantConnection = .same ∧
      e.rootGrant ∧ e.shallowGrant ∧ e.grantActive ∧ e.stored ∧ e.row = .active ∧
      e.urlAllowed := by
  unfold egress at h
  split at h
  · cases h
  · rename_i guard
    split at h
    · cases h
    · rename_i stored
      cases row : e.row <;> simp only [row] at h
      · split at h
        · simp_all [bne_iff_ne]
        · cases h
      · cases h
      · cases h

/-! Vectors: one tab-separated line per case, tagged by family. -/

private def pathName : Path → String
  | .invoke => "invoke" | .independent => "independent" | .frozen => "frozen"
private def connectorName : Connector → String
  | .hostMock => "host-mock" | .registered => "registered"
private def providerName : Provider → String
  | .ok => "ok" | .notOk => "not-ok" | .error => "error"
private def outcomeName : Outcome → String
  | .succeeded => "succeeded" | .failed => "failed" | .indeterminate => "indeterminate"
private def leakName : Leak → String
  | .none => "none" | .summary => "summary" | .requestDigest => "request-digest"
  | .responseDigest => "response-digest" | .plainDigest => "plain-digest"
private def schemaName : Schema → String | .legacy => "legacy" | .v6 => "opaque"
private def keyName : Key → String | .active => "active" | .other => "other"
private def openingName : Opening → String
  | .own => "own" | .otherInvocation => "other-invocation" | .malformed => "malformed"
private def digestName : Digest → String
  | .original => "original" | .other => "other" | .malformed => "malformed"
private def changeName : Change → String
  | .exact => "exact" | .policyId => "policy-id" | .connectionRef => "connection-ref"
  | .operation => "operation" | .authorizedOperation => "authorized-operation"
  | .resource => "resource" | .audience => "audience" | .level => "level"
  | .parametersDigest => "parameters-digest" | .parameters => "parameters"
private def dispatchName : Dispatch → String
  | .hostMock => "host-mock" | .connector => "connector" | .mismatch => "mismatch"
  | .delegatedRefused => "delegated-refused"
private def captureName : Capture → String
  | .consistent => "consistent" | .organization => "organization" | .principal => "principal"
  | .connection => "connection" | .subject => "subject" | .policyId => "policy-id"
  | .lineage => "lineage" | .chain => "chain"
private def egressName : EgressResult → String
  | .sent => "sent" | .notFound => "not-found" | .revoked => "revoked"
  | .needsReauth => "needs-reauth" | .refused => "refused"
private def flag (b : Bool) : String := if b then "1" else "0"

/-- The harness fixtures realize every case except host-mock dispatch with an
`ok = false` provider (the mock has no such operation) and frozen dispatch to
the host mock (the frozen fixture binds a registered connector). -/
def realizable : Path → Connector → Provider → Bool
  | .invoke, .hostMock, .notOk => false
  | .frozen, .hostMock, _ => false
  | _, _, _ => true

def exactEgress : Egress :=
  { providerGiven := true, providerMatches := true, ownerGiven := true, ownerMatches := true,
    grantOrganization := true, grantConnection := .same, rootGrant := true,
    shallowGrant := true, grantActive := true, stored := true, row := .active,
    urlAllowed := true }

/-- Each named case perturbs exactly one input of `exactEgress`. -/
def egressCases : List (String × Egress) :=
  let e := exactEgress
  [("exact", e), ("empty-provider", { e with providerGiven := false, providerMatches := false }),
   ("other-provider", { e with providerMatches := false }),
   ("empty-owner", { e with ownerGiven := false, ownerMatches := false }),
   ("other-owner", { e with ownerMatches := false }),
   ("grant-organization", { e with grantOrganization := false }),
   ("grant-connection-absent", { e with grantConnection := .absent }),
   ("grant-connection-other", { e with grantConnection := .other }),
   ("child-grant", { e with rootGrant := false }),
   ("delegation-depth", { e with shallowGrant := false }),
   ("expired-grant", { e with grantActive := false }),
   ("revoked-grant", { e with grantActive := false }),
   ("stored-grant-differs", { e with stored := false }),
   ("stored-grant-missing", { e with stored := false }),
   ("row-revoked", { e with row := .revoked }),
   ("row-needs-reauth", { e with row := .needsReauth }),
   ("url-outside-egress", { e with urlAllowed := false })]

def main : IO Unit := do
  for path in [Path.invoke, .independent, .frozen] do
    for c in [Connector.hostMock, .registered] do
      for p in [Provider.ok, .notOk, .error] do
        if realizable path c p then
          let r := receipt path c p
          IO.println s!"o1\t{pathName path}\t{connectorName c}\t{providerName p}\t{outcomeName r.outcome}\t{flag r.summary}{flag r.requestDigest}{flag r.responseDigest}"
  for s in [Schema.legacy, .v6] do
    for l in [Leak.none, .summary, .requestDigest, .responseDigest, .plainDigest] do
      for k in [Key.active, .other] do
        for t in [false, true] do
          let signed := signs s l
          let result := if signed then flag (opens s l k t) else "refused"
          IO.println s!"o2\t{schemaName s}\t{leakName l}\t{keyName k}\t{flag t}\t{result}"
  for s in [Schema.legacy, .v6] do
    for o in [Opening.own, .otherInvocation, .malformed] do
      for d in [Digest.original, .other, .malformed] do
        IO.println s!"o2-opening\t{schemaName s}\t{openingName o}\t{digestName d}\t{flag (verifiesOpening s o d)}"
  for c in [Connector.hostMock, .registered] do
    IO.println s!"d1\tunbound\texact\t0\t{connectorName c}\t{dispatchName (dispatch .unbound .exact false c)}"
    for change in [Change.exact, .policyId, .connectionRef, .operation, .authorizedOperation,
        .resource, .audience, .level, .parametersDigest, .parameters] do
      for delegated in [false, true] do
        IO.println s!"d1\tbound\t{changeName change}\t{flag delegated}\t{connectorName c}\t{dispatchName (dispatch .bound change delegated c)}"
  for v in [Capture.consistent, .organization, .principal, .connection, .subject, .policyId,
      .lineage, .chain] do
    IO.println s!"d1-capture\t{captureName v}\t{flag (captures v)}"
  for api in ["json", "http"] do
    for (name, e) in egressCases do
      IO.println s!"d2\t{api}\t{name}\t{egressName (egress e)}"

end OpenSesame.InvocationEffects
