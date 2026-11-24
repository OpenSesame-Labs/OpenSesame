/-! The gateway parts of INV-O2, INV-D1 and INV-D2, and the broker's
`reject_delegated` path, continuing `InvocationEffects.lean`.

Each decision transcribes named Rust guards; the vectors printed by `main`
are replayed against those functions by harnesses inside the existing gateway
and broker test modules. Identities, digests and signatures are abstracted to
whether they match; SHA-256 is assumed collision resistant, Ed25519
unforgeable. -/

namespace OpenSesame.InvocationGateway

/-! INV-O2. `recover` (crates/gateway/src/routes/tasks_opening.rs):
`resolve_caller` and `resolve_caller_subject` refuse an unauthenticated
request with 401 before the body is read. Every later refusal is the same 404:
the body must parse, its digest must equal the recomputed digest of the
intent, and the intent must be the canonical wire form (no extra field); the
caller must own the intent's principal and be in its organization (the
operator does both, `Caller::owns` and `in_organization` in
crates/gateway/src/middleware/auth.rs); the active bootstrap authority, the
broker's `recover_frozen_receipt` (task, grant and subject-bound fingerprint)
and `open_receipt_intent` (signature under the active key) must succeed. -/

inductive Caller where
  | anonymous | owner | operator | otherPrincipal | otherOrganization
  deriving DecidableEq, Repr

/-- The recovery body: the saved one, another valid digest, an extra intent
field, or a different intent (new nonce) with its own correct digest. -/
inductive Request where
  | exact | otherDigest | extraField | otherIntent
  deriving DecidableEq, Repr

/-- What changed since the invocation settled, if anything. -/
inductive Authority where
  | intact | grantChanged | receiptTampered | signerRetired | grantRevoked
  deriving DecidableEq, Repr

inductive Recovery where
  | unauthorized | notFound | opening
  deriving DecidableEq, Repr

def owns : Caller → Bool
  | .owner | .operator | .otherOrganization => true
  | .anonymous | .otherPrincipal => false

def inOrganization : Caller → Bool
  | .owner | .operator | .otherPrincipal => true
  | .anonymous | .otherOrganization => false

def recover (c : Caller) (r : Request) (a : Authority) : Recovery :=
  if c == .anonymous then .unauthorized
  else if r == .otherDigest || r == .extraField then .notFound
  else if !(owns c && inOrganization c) then .notFound
  else if r == .otherIntent || a != .intact then .notFound
  else .opening

theorem o2_recovery_opens_only_for_owner_saved_intent_and_intact_authority
    (c : Caller) (r : Request) (a : Authority) (h : recover c r a = .opening) :
    (c = .owner ∨ c = .operator) ∧ r = .exact ∧ a = .intact := by
  cases c <;> cases r <;> cases a <;> simp_all [recover, owns, inOrganization]

theorem o2_recovery_unauthenticated_is_refused (r : Request) (a : Authority) :
    recover .anonymous r a = .unauthorized := rfl

theorem o2_recovery_refusals_are_indistinguishable (c : Caller) (r : Request)
    (a : Authority) (h : c ≠ .anonymous) :
    recover c r a = .opening ∨ recover c r a = .notFound := by
  cases c <;> cases r <;> cases a <;> simp_all [recover, owns, inOrganization]

theorem o2_recovery_foreign_caller_never_opens (r : Request) (a : Authority) :
    recover .otherPrincipal r a ≠ .opening ∧ recover .otherOrganization r a ≠ .opening := by
  cases r <;> cases a <;> simp [recover, owns, inOrganization]

/-! INV-D1. `ensure_effect_allowed` (crates/gateway/src/routes/intents_budget.rs):
`delegated` is `spend_budget.is_some()`, `child` is a parent grant or a
non-zero delegation depth; the shape is consistent when `delegated` agrees with
the lineage and with `child`, and a delegated call resolved through the
durable broker. A consistent owner call is admitted; a consistent delegated
call only as a replay, or for the inert builtin mock without an independent
executor. -/

structure Admission where
  spend : Bool
  lineage : Bool
  parent : Bool
  depth : Bool
  brokerConnection : Bool
  independent : Bool
  replay : Bool
  inertMock : Bool
  deriving DecidableEq, Repr

def effectAllowed (f : Admission) : Bool :=
  let child := f.parent || f.depth
  let consistent := f.spend == f.lineage && f.spend == child && (!f.spend || f.brokerConnection)
  consistent && (!f.spend || f.replay || (!f.independent && f.inertMock))

theorem d1_admission_requires_a_consistent_delegation_shape (f : Admission)
    (h : effectAllowed f = true) :
    f.spend = f.lineage ∧ f.spend = (f.parent || f.depth) ∧
      (f.spend = true → f.brokerConnection = true) := by
  cases f with
  | mk s l p d b i r m => cases s <;> cases l <;> cases p <;> cases d <;> cases b <;>
      cases i <;> cases r <;> cases m <;> simp_all [effectAllowed]

theorem d1_delegated_effect_only_replay_or_local_inert_mock (f : Admission)
    (h : effectAllowed f = true) (delegated : f.spend = true) :
    f.replay = true ∨ (f.independent = false ∧ f.inertMock = true) := by
  cases f with
  | mk s l p d b i r m => cases s <;> cases l <;> cases p <;> cases d <;> cases b <;>
      cases i <;> cases r <;> cases m <;> simp_all [effectAllowed]

theorem d1_owner_effect_is_admitted (b i r m : Bool) :
    effectAllowed ⟨false, false, false, false, b, i, r, m⟩ = true := by
  cases b <;> cases i <;> cases r <;> cases m <;> rfl

/-! INV-D1. `invoke_with_mode` (crates/broker/src/lib.rs) with
`reject_delegated`, which only `invoke_with_bound`
(crates/broker/src/independent_executor.rs) sets: after an allowing decision a
delegated binding is refused before an intent is stored or the executor runs;
a denial records a denied receipt. -/

inductive GrantShape where
  | root | child
  deriving DecidableEq, Repr

inductive Independent where
  | executed | denied | delegatedRefused
  deriving DecidableEq, Repr

def independentInvoke (g : GrantShape) (allows : Bool) : Independent :=
  if !allows then .denied else if g == .child then .delegatedRefused else .executed

theorem d1_independent_executor_never_runs_a_delegated_effect (allows : Bool) :
    independentInvoke .child allows ≠ .executed := by
  cases allows <;> simp [independentInvoke]

theorem d1_independent_effect_requires_root_and_allow (g : GrantShape) (allows : Bool)
    (h : independentInvoke g allows = .executed) : g = .root ∧ allows = true := by
  cases g <;> cases allows <;> simp_all [independentInvoke]

/-! INV-D2. `accepts_binding` (crates/gateway/src/connector_egress.rs), which
`GatewayEgress::authorized_request` calls before any broker egress: the
binding must carry a connection, be a root (not delegated) binding, name the
connection policy the guest asked for, which must also be the registered
manifest provider, and its grant must name that connection and be active. -/

inductive GrantConnection where
  | same | absent | other
  deriving DecidableEq, Repr

structure Registration where
  connection : Bool
  grantConnection : GrantConnection
  delegated : Bool
  policyMatches : Bool
  providerMatches : Bool
  grantActive : Bool
  deriving DecidableEq, Repr

def acceptsBinding (r : Registration) : Bool :=
  r.connection && !r.delegated && r.policyMatches && r.providerMatches &&
    r.grantConnection == .same && r.grantActive

theorem d2_registration_accepts_only_the_owner_root_binding (r : Registration)
    (h : acceptsBinding r = true) :
    r.connection ∧ r.delegated = false ∧ r.policyMatches ∧ r.providerMatches ∧
      r.grantConnection = .same ∧ r.grantActive := by
  simp_all [acceptsBinding]

theorem d2_registration_refuses_a_delegated_binding (r : Registration)
    (h : r.delegated = true) : acceptsBinding r = false := by
  simp [acceptsBinding, h]

/-! Vectors: one tab-separated line per case, tagged by family. -/

private def flag (b : Bool) : String := if b then "1" else "0"
private def callerName : Caller → String
  | .anonymous => "anonymous" | .owner => "owner" | .operator => "operator"
  | .otherPrincipal => "other-principal" | .otherOrganization => "other-organization"
private def requestName : Request → String
  | .exact => "exact" | .otherDigest => "other-digest" | .extraField => "extra-field"
  | .otherIntent => "other-intent"
private def authorityName : Authority → String
  | .intact => "intact" | .grantChanged => "grant-changed"
  | .receiptTampered => "receipt-tampered" | .signerRetired => "signer-retired"
  | .grantRevoked => "grant-revoked"
private def recoveryName : Recovery → String
  | .unauthorized => "unauthorized" | .notFound => "not-found" | .opening => "opening"
private def independentName : Independent → String
  | .executed => "executed" | .denied => "denied" | .delegatedRefused => "delegated-refused"
private def grantConnectionName : GrantConnection → String
  | .same => "same" | .absent => "absent" | .other => "other"

private def bools : List Bool := [false, true]

/-- `from_intent` ties the grant's connection to the intent's, so a grant naming
another connection, or a connection the binding lacks, has no binding; a
validated lineage needs an active child grant. -/
def realizable (r : Registration) (activity : String) : Bool :=
  (r.connection || r.grantConnection == .absent) && r.grantConnection != .other &&
    (!r.delegated || activity == "active")

def main : IO Unit := do
  -- Revocation cannot be undone, so it is the last authority state replayed.
  for a in [Authority.intact, .grantChanged, .receiptTampered, .signerRetired, .grantRevoked] do
    for c in [Caller.anonymous, .owner, .operator, .otherPrincipal, .otherOrganization] do
      for r in [Request.exact, .otherDigest, .extraField, .otherIntent] do
        IO.println s!"o2-recover\t{callerName c}\t{requestName r}\t{authorityName a}\t{recoveryName (recover c r a)}"
  for s in bools do for l in bools do for p in bools do for d in bools do
    for b in bools do for i in bools do for r in bools do for m in bools do
      let f : Admission := ⟨s, l, p, d, b, i, r, m⟩
      let bits := String.join ([s, l, p, d, b, i, r, m].map flag)
      IO.println s!"d1-admit\t{bits}\t{if effectAllowed f then "allowed" else "refused"}"
  for g in [GrantShape.root, .child] do
    for allows in bools do
      let name := if g == .root then "root" else "child"
      IO.println s!"d1-reject\t{name}\t{flag allows}\t{independentName (independentInvoke g allows)}"
  for conn in bools do
    for gc in [GrantConnection.same, .absent, .other] do
      for del in bools do for pol in bools do for prov in bools do
        for activity in ["active", "expired", "revoked", "not-yet-valid"] do
          let r : Registration := ⟨conn, gc, del, pol, prov, activity == "active"⟩
          if realizable r activity then
            IO.println s!"d2-accept\t{flag conn}\t{grantConnectionName gc}\t{flag del}\t{flag pol}\t{flag prov}\t{activity}\t{flag (acceptsBinding r)}"

end OpenSesame.InvocationGateway

def main : IO Unit := do
  OpenSesame.Invocation.main
  OpenSesame.InvocationEffects.main
  OpenSesame.InvocationGateway.main
