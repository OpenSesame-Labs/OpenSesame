import Lean

set_option autoImplicit false

/-! CLI-WA1–WA3, RELAY-T1, RELAY-F1. Each definition mirrors the Rust decision named
in its heading. Strings, hashes, JSON and P-256 are abstracted to comparison results;
`main` emits the vectors the Rust correspondence tests replay against the real code. -/

namespace OpenSesame.HostCli

/-! ## CLI-WA1: `verify_passkey_assertion` (webauthn_assertion.rs) -/

inductive ClientType | get | create deriving DecidableEq, Repr
inductive Cross | absent | no | yes deriving DecidableEq, Repr
inductive Top | absent | same | other deriving DecidableEq, Repr

/-- Comparison outcomes in the verifier's order: wire credential id; clientData type,
origin, crossOrigin (absent defaults to false) and topOrigin; challenge digest; stored
origin pairable (so an RP hash exists); authData[0..32] = SHA-256(host); UP (0x01) and UV
(0x04) flags; authData ≥ 37 bytes; sign count; P-256 signature under the stored key. -/
structure Assertion where
  (credential : Bool) (clientType : ClientType) (origin : Bool) (cross : Cross) (top : Top)
  (challenge pairable rp up uv long : Bool) (count : Nat) (signature : Bool)
  deriving Repr

def originAccepted (a : Assertion) : Bool :=
  a.clientType == .get && a.origin && a.cross != .yes && a.top != .other

def presence (a : Assertion) : Bool := a.pairable && a.long && a.rp && a.up && a.uv

/-- Counterless (both zero) or strictly increasing. -/
def counterAccepted (count stored : Nat) : Bool := (count == 0 && stored == 0) || stored < count

def verify (a : Assertion) (stored : Nat) : Option Nat :=
  if a.credential && originAccepted a && a.challenge && presence a &&
      counterAccepted a.count stored && a.signature then some a.count else none

theorem assertion_requires_exact_origin (a : Assertion) (stored n : Nat) :
    verify a stored = some n →
      a.clientType = .get ∧ a.origin = true ∧ a.cross ≠ .yes ∧ a.top ≠ .other := by
  intro h; unfold verify at h; split at h <;> simp_all [originAccepted]

theorem assertion_requires_rp_and_presence (a : Assertion) (stored n : Nat) :
    verify a stored = some n →
      a.pairable = true ∧ a.long = true ∧ a.rp = true ∧ a.up = true ∧ a.uv = true := by
  intro h; unfold verify at h; split at h <;> simp_all [presence]

theorem assertion_binds_challenge_and_key (a : Assertion) (stored n : Nat) :
    verify a stored = some n →
      a.credential = true ∧ a.challenge = true ∧ a.signature = true ∧ n = a.count := by
  intro h; unfold verify at h; split at h <;> simp_all

theorem assertion_counter_advances (a : Assertion) (stored n : Nat) :
    verify a stored = some n → stored < n ∨ (n = 0 ∧ stored = 0) := by
  intro h; unfold verify at h; split at h
  · have hk : counterAccepted a.count stored = true := by simp_all
    have he : a.count = n := by simp_all
    subst he
    rcases Nat.lt_or_ge stored a.count with hs | hs
    · exact Or.inl hs
    · have hf : decide (stored < a.count) = false := decide_eq_false (Nat.not_lt.mpr hs)
      simp only [counterAccepted, hf, Bool.or_false, Bool.and_eq_true, beq_iff_eq] at hk
      exact Or.inr hk
  · cases h

theorem exact_present_assertion_accepted :
    verify ⟨true, .get, true, .no, .same, true, true, true, true, true, true, 1, true⟩ 0 = some 1 := rfl

/-! ## CLI-WA2: `register_webauthn` (pairing/binding.rs) -/

inductive CredId | a | b deriving DecidableEq, Repr
inductive Key | k1 | k2 | device deriving DecidableEq, Repr
structure Cred where
  (id : CredId) (key : Key) (count : Nat)
  deriving DecidableEq, Repr

/-- `found`: bearer and origin name a paired page; `digest`: the vault-session root digest
matches; `verified`: the assertion count, checked against a stored count of 0. -/
structure Registration where
  (found digest : Bool) (id : CredId) (key : Key) (verified : Option Nat)
  deriving Repr

inductive RegResult | ok | unknown | invalid deriving DecidableEq, Repr

/-- Shape checks and the root-key precondition are assumed to pass. -/
def register (slot : Option Cred) (r : Registration) : RegResult × Option Cred :=
  if !r.found then (.unknown, slot)
  else if !r.digest || r.key == .device then (.invalid, slot)
  else match slot, r.verified with
    | some c, some n =>
        if c.id != r.id || c.key != r.key then (.invalid, slot)
        else (.ok, some { c with count := max c.count n })
    | some _, none => (.invalid, slot)
    | none, some n => (.ok, some ⟨r.id, r.key, n⟩)
    | none, none => (.invalid, slot)

/-- `advance_webauthn_sign_count`, the approval-side counter update. -/
def advance : Option Cred → Nat → Bool × Option Cred
  | none, _ => (false, none)
  | slot@(some c), n =>
      if n == 0 && c.count == 0 then (true, slot)
      else if n ≤ c.count then (false, slot)
      else (true, some { c with count := n })

inductive Step | reg (r : Registration) | adv (n : Nat) deriving Repr

def step (slot : Option Cred) : Step → Option Cred
  | .reg r => (register slot r).2
  | .adv n => (advance slot n).2

def run (slot : Option Cred) (steps : List Step) : Option Cred := steps.foldl step slot

theorem register_never_replaces (c : Cred) (r : Registration) :
    ∃ c', (register (some c) r).2 = some c' ∧ c'.id = c.id ∧ c'.key = c.key ∧ c.count ≤ c'.count := by
  unfold register; repeat' split
  all_goals simp_all
  all_goals first | exact ⟨c, rfl, rfl, Nat.le_refl _⟩ | omega

theorem register_attaches_only_verified (r : Registration) (c : Cred) :
    (register none r).2 = some c →
      r.found = true ∧ r.digest = true ∧ r.key ≠ .device ∧ r.verified = some c.count ∧
        c.id = r.id ∧ c.key = r.key := by
  unfold register; repeat' split
  all_goals intro h; simp_all
  all_goals (subst h; simp_all)

theorem register_failure_is_inert (slot : Option Cred) (r : Registration) :
    (register slot r).1 ≠ .ok → (register slot r).2 = slot := by
  unfold register; repeat' split
  all_goals simp_all

theorem step_keeps_credential (c : Cred) (s : Step) :
    ∃ c', step (some c) s = some c' ∧ c'.id = c.id ∧ c'.key = c.key ∧ c.count ≤ c'.count := by
  cases s with
  | reg r => exact register_never_replaces c r
  | adv n =>
    simp only [step, advance]; split
    · exact ⟨c, rfl, rfl, rfl, Nat.le_refl _⟩
    · split
      · exact ⟨c, rfl, rfl, rfl, Nat.le_refl _⟩
      · exact ⟨{ c with count := n }, rfl, rfl, rfl, by simp only; omega⟩

/-- Over any finite history of retries and approvals, the attached credential
never changes and its highest observed count never falls. -/
theorem history_keeps_credential (steps : List Step) (c : Cred) :
    ∃ c', run (some c) steps = some c' ∧ c'.id = c.id ∧ c'.key = c.key ∧ c.count ≤ c'.count := by
  induction steps generalizing c with
  | nil => exact ⟨c, rfl, rfl, rfl, Nat.le_refl _⟩
  | cons s rest ih =>
    obtain ⟨c₁, h₁, hi₁, hk₁, hn₁⟩ := step_keeps_credential c s
    obtain ⟨c₂, h₂, hi₂, hk₂, hn₂⟩ := ih c₁
    refine ⟨c₂, ?_, hi₂.trans hi₁, hk₂.trans hk₁, Nat.le_trans hn₁ hn₂⟩
    simp only [run, List.foldl] at h₂ ⊢
    rw [show step (some c) s = some c₁ from h₁]
    exact h₂

/-! ## CLI-WA3: `ensure` (lib.rs), `human_proof_verify` (human_proof.rs) -/

/-- `policy::is_approval_blocked`: unconditionally true until provenance exists. -/
def approvalBlocked (_verb : String) : Bool := true

inductive Session | none | fresh | idle | hard deriving DecidableEq, Repr
inductive Pending | none | live | stale deriving DecidableEq, Repr
structure Store where
  (approved : Session) (pending : Pending) (denied : Bool)
  deriving DecidableEq, Repr

inductive Ensure | denied | pending | approved | expired deriving DecidableEq, Repr

/-- `expire_pending` runs first; a blocked verb returns before any reuse,
coalescing or insertion. -/
def ensure (s : Store) (verb : String) (_reuse _approvable : Bool) : Ensure × Store :=
  let s := { s with pending := if s.pending == .stale then .none else s.pending }
  if approvalBlocked verb || s.denied then (.denied, s)
  else (.pending, s)  -- unreachable while blocked; never emitted as an expectation

inductive Label | passkey | software | pin | v2passkey | v1pin | bare deriving DecidableEq, Repr

/-- `human_proof_verify`: the blocked check precedes every proof label. -/
def humanProof (verb : String) (pinLocked : Bool) (label : Label) (valid : Bool) : Option Nat :=
  if approvalBlocked verb || pinLocked then none
  else match label with
    | .passkey | .software => if valid then some 2 else none
    | _ => none

/-- `approve`: a proof that does not verify leaves the row and sessions alone. -/
def approve (verb : String) (label : Label) (valid : Bool) : Bool :=
  (humanProof verb false label valid).isSome

theorem ensure_always_denied (s : Store) (verb : String) (reuse approvable : Bool) :
    (ensure s verb reuse approvable).1 = .denied := by
  simp [ensure, approvalBlocked]

theorem ensure_creates_and_reuses_nothing (s : Store) (verb : String) (reuse approvable : Bool) :
    (ensure s verb reuse approvable).2.approved = s.approved ∧
      (ensure s verb reuse approvable).2.denied = s.denied ∧
      (ensure s verb reuse approvable).2.pending ≠ .stale ∧
      ((ensure s verb reuse approvable).2.pending = .live → s.pending = .live) := by
  cases h : s.pending <;> simp [ensure, approvalBlocked, h]

theorem human_proof_never_verifies (verb : String) (pinLocked : Bool) (label : Label) (valid : Bool) :
    humanProof verb pinLocked label valid = none := by
  simp [humanProof, approvalBlocked]

theorem approval_never_granted (verb : String) (label : Label) (valid : Bool) :
    approve verb label valid = false := by
  simp [approve, human_proof_never_verifies]

/-! ## RELAY-T1 and RELAY-F1 routes (relay.rs, relay_scope.rs) -/

inductive Org | a | b deriving DecidableEq, Repr
inductive Party | holder | delegate | stranger deriving DecidableEq, Repr
/-- Sessions carry their own organization; the operator acts as the bootstrap
principal in the bootstrap organization `a`. -/
inductive Caller | session (org : Org) (party : Party) | operator (party : Party) | anonymous
  deriving DecidableEq, Repr
inductive Route | heartbeat | submit | pending | approve | deny | result | get
  deriving DecidableEq, Repr
inductive Stored | pendingApproval | approved | denied | completed | failed | bogus
  deriving DecidableEq, Repr
structure Row where
  (org : Org) (state : Stored) (expired : Bool)
  deriving DecidableEq, Repr
inductive View | pendingApproval | approved | denied | completed | failed | expired | unknown
  deriving DecidableEq, Repr
inductive Reply | unauthorized | notFound | unavailable | deniedOk | view (v : View)
  deriving DecidableEq, Repr

def scope : Caller → Option (Org × Party)
  | .session org party => some (org, party) | .operator party => some (.a, party) | .anonymous => none

def view (r : Row) : View :=
  if r.state != .completed && r.expired then .expired
  else match r.state with
    | .pendingApproval => .pendingApproval | .approved => .approved | .denied => .denied
    | .completed => .completed | .failed => .failed | .bogus => .unknown

def handle (c : Caller) (route : Route) (r : Row) : Reply × Stored :=
  match scope c with
  | none => (.unauthorized, r.state)
  | some (org, party) =>
    match route with
    | .get =>
        if org == r.org && party != .stranger then (.view (view r), r.state)
        else (.notFound, r.state)
    | .deny =>
        if org == r.org && party == .holder && r.state == .pendingApproval && !r.expired
        then (.deniedOk, .denied) else (.notFound, r.state)
    | _ => (.unavailable, r.state)

theorem cross_tenant_refused (c : Caller) (route : Route) (r : Row) (org : Org) (party : Party) :
    scope c = some (org, party) → org ≠ r.org →
      (handle c route r).2 = r.state ∧ ∀ v, (handle c route r).1 ≠ .view v := by
  intro hs ho
  have hne : (org == r.org) = false := by simpa using ho
  cases route <;> simp [handle, hs, hne]

theorem view_requires_party (c : Caller) (route : Route) (r : Row) (v : View) :
    (handle c route r).1 = .view v →
      route = .get ∧ ∃ party, scope c = some (r.org, party) ∧ party ≠ .stranger := by
  cases hs : scope c with
  | none => simp [handle, hs]
  | some p => obtain ⟨org, party⟩ := p; cases route <;> simp [handle, hs] <;> (try split) <;> simp_all

theorem state_change_requires_holder (c : Caller) (route : Route) (r : Row) :
    (handle c route r).2 ≠ r.state →
      route = .deny ∧ scope c = some (r.org, .holder) ∧ r.state = .pendingApproval ∧
        r.expired = false := by
  cases hs : scope c with
  | none => simp [handle, hs]
  | some p => obtain ⟨org, party⟩ := p; cases route <;> simp [handle, hs] <;> (try split) <;> simp_all

theorem anonymous_refused (route : Route) (r : Row) :
    handle .anonymous route r = (.unauthorized, r.state) := by
  simp [handle, scope]

/-- RELAY-F1: once authenticated, submission, executable inbox disclosure,
approval, results and heartbeats are unavailable and change nothing. -/
theorem execution_routes_unavailable (c : Caller) (route : Route) (r : Row) (org : Org) (party : Party) :
    scope c = some (org, party) → route ≠ .get → route ≠ .deny →
      handle c route r = (.unavailable, r.state) := by
  intro hs hg hd; cases route <;> simp_all [handle]

/-! ## RELAY-F1: stored execution modes (delegation_mode.rs, intents_queue.rs) -/

inductive Mode | relay | broker deriving DecidableEq, Repr
inductive StoredMode | relay | broker | upper | shout | padded | empty | unknown
  deriving DecidableEq, Repr

/-- `parse_execution_mode` has no fallback; `resolve_live_delegation` returns
no delegation for an unknown stored value. -/
def parseMode : StoredMode → Option Mode
  | .relay => some .relay | .broker => some .broker | _ => none

/-- `require_claimable_mode` and `require_mint_modes`. -/
def claimable : Mode → Bool | .relay => true | .broker => false

inductive Invoke | relayUnavailable | delegatedUnavailable | notFound | executed
  deriving DecidableEq, Repr

/-- The delegated invoke path: no live delegation is `not_found`, and
`require_delegated_mode` refuses both parsed modes. -/
def delegatedInvoke (stored : StoredMode) : Invoke :=
  match parseMode stored with
  | none => .notFound
  | some .relay => .relayUnavailable
  | some .broker => .delegatedUnavailable

theorem unknown_mode_has_no_authority (s : StoredMode) :
    s ≠ .relay → s ≠ .broker → parseMode s = none := by
  cases s <;> simp [parseMode]
theorem broker_mode_not_claimable : claimable .broker = false := rfl

theorem delegated_invoke_never_executes (s : StoredMode) : delegatedInvoke s ≠ .executed := by
  cases s <;> simp [delegatedInvoke, parseMode]

theorem relay_only_never_falls_back (s : StoredMode) :
    parseMode s = some .relay → delegatedInvoke s = .relayUnavailable := by
  intro h; simp [delegatedInvoke, h]

/-! ## Vectors -/
private def bit (b : Bool) : String := if b then "1" else "0"
private def opt : Option Nat → String | none => "-" | some n => toString n
private def bools : List Bool := [false, true]
private def nm {α} [Repr α] (x : α) : String := (reprStr x).replace "OpenSesame.HostCli." ""
def wa1Line (a : Assertion) (stored : Nat) : String :=
  s!"wa1\t{bit a.credential}\t{nm a.clientType}\t{bit a.origin}\t{nm a.cross}\t{nm a.top}\t" ++
  s!"{bit a.challenge}\t{bit a.pairable}\t{bit a.rp}\t{bit a.up}\t{bit a.uv}\t{bit a.long}\t" ++
  s!"{a.count}\t{a.signature |> bit}\t{stored}\t{opt (verify a stored)}"
/-- Origin, client type and presence facets, all combinations. -/
def wa1Origin : List (Assertion × Nat) :=
  [ClientType.get, .create].flatMap fun ty => bools.flatMap fun o =>
  [Cross.absent, .no, .yes].flatMap fun x => [Top.absent, .same, .other].flatMap fun t =>
  bools.flatMap fun p => bools.flatMap fun rp => bools.flatMap fun up =>
  bools.flatMap fun uv => bools.map fun l =>
    (⟨true, ty, o, x, t, true, p, rp, up, uv, l, 1, true⟩, 0)
/-- Credential, challenge, signature and counter facets, all combinations. -/
def wa1Binding : List (Assertion × Nat) :=
  bools.flatMap fun c => bools.flatMap fun ch => bools.flatMap fun sig =>
  [0, 1, 2].flatMap fun n => [0, 1, 2].map fun s =>
    (⟨c, .get, true, .no, .same, ch, true, true, true, true, true, n, sig⟩, s)
private def slotStr : Option Cred → String
  | none => "none" | some c => s!"{nm c.id}:{nm c.key}:{c.count}"
private def regStr (r : Registration) : String :=
  s!"{bit r.found}:{bit r.digest}:{nm r.id}:{nm r.key}:{opt r.verified}"
def wa2Single : List (Option Cred × Registration) :=
  [none, some ⟨.a, .k1, 0⟩, some ⟨.a, .k1, 1⟩, some ⟨.a, .k1, 2⟩].flatMap fun slot =>
  bools.flatMap fun f => bools.flatMap fun d => [CredId.a, .b].flatMap fun id =>
  [Key.k1, .k2, .device].flatMap fun k => [none, some 0, some 1, some 2].map fun v =>
    (slot, ⟨f, d, id, k, v⟩)
def alphabet : List Step :=
  [.reg ⟨true, true, .a, .k1, some 0⟩, .reg ⟨true, true, .a, .k1, some 2⟩,
   .reg ⟨true, true, .a, .k1, none⟩, .reg ⟨true, true, .b, .k1, some 1⟩,
   .reg ⟨true, true, .a, .k2, some 1⟩, .adv 0, .adv 1, .adv 3]
private def stepStr : Step → String | .reg r => s!"reg:{regStr r}" | .adv n => s!"adv:{n}"
private def stepResult (slot : Option Cred) : Step → String
  | .reg r => nm (register slot r).1
  | .adv n => bit (advance slot n).1
def verbs : List String :=
  ["run", "pass-reveal", "read", "reveal", "env-resolve", "daemon-pin-probe", "unknown", ""]
def ensureCases : List (String × Store × Bool × Bool) :=
  verbs.flatMap fun verb => [Session.none, .fresh, .idle, .hard].flatMap fun a =>
  [Pending.none, .live, .stale].flatMap fun p => bools.flatMap fun d =>
  bools.flatMap fun reuse => bools.map fun ap => (verb, ⟨a, p, d⟩, reuse, ap)
def relayCallers : List Caller :=
  [.session .a .holder, .session .a .delegate, .session .a .stranger, .session .b .holder,
   .session .b .delegate, .operator .holder, .operator .delegate, .operator .stranger, .anonymous]
private def replyStr : Reply → String | .view v => s!"view:{nm v}" | r => nm r

def main : IO Unit := do
  for (a, s) in wa1Origin ++ wa1Binding do IO.println (wa1Line a s)
  for (slot, r) in wa2Single do
    let (res, after) := register slot r
    IO.println s!"wa2\t{slotStr slot}\t{regStr r}\t{nm res}\t{slotStr after}"
  for x in alphabet do for y in alphabet do for z in alphabet do
    let s1 := step none x; let s2 := step s1 y; let s3 := step s2 z
    IO.println s!"wa2seq\t{stepStr x},{stepStr y},{stepStr z}\t{stepResult none x},{stepResult s1 y},{stepResult s2 z}\t{slotStr s3}"
  for (verb, s, reuse, ap) in ensureCases do
    let (res, after) := ensure s verb reuse ap
    IO.println s!"wa3e\t{verb}\t{nm s.approved}\t{nm s.pending}\t{bit s.denied}\t{bit reuse}\t{bit ap}\t{nm res}\t{nm after.pending}"
  for verb in verbs do
    for label in [Label.passkey, .software, .pin, .v2passkey, .v1pin, .bare] do
      for valid in bools do for locked in bools do
        IO.println s!"wa3p\t{verb}\t{nm label}\t{bit valid}\t{bit locked}\t{opt (humanProof verb locked label valid)}\t{bit (approve verb label valid)}"
  for c in relayCallers do
    for route in [Route.heartbeat, .submit, .pending, .approve, .deny, .result, .get] do
      for org in [Org.a, .b] do
        for st in [Stored.pendingApproval, .approved, .denied, .completed, .failed, .bogus] do
          for ex in bools do
            let (reply, after) := handle c route ⟨org, st, ex⟩
            IO.println s!"relay\t{nm c}\t{nm route}\t{nm org}\t{nm st}\t{bit ex}\t{replyStr reply}\t{nm after}"
  for s in [StoredMode.relay, .broker, .upper, .shout, .padded, .empty, .unknown] do
    let claim := match parseMode s with
      | none => "invalid" | some m => if claimable m then "ok" else "unavailable"
    IO.println s!"mode\t{nm s}\t{nm (parseMode s)}\t{claim}\t{nm (delegatedInvoke s)}"

end OpenSesame.HostCli

def main : IO Unit := OpenSesame.HostCli.main
