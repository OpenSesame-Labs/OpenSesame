import Lean

set_option autoImplicit false

namespace OpenSesame.SourceTrustHistory

/- A record stands for validated, complete history. Absence represents both a
   missing row and failure to obtain a valid record; neither permits a write.
   Names are lists here and are compared by membership. The runtime uses a
   sorted, duplicate-free set. This model does not assert that the database is
   durable, an operator's completeness claim is truthful, or Rust refines it. -/
structure Record where
  revision : Nat
  names : List Nat
  deriving DecidableEq, Repr

def bootstrap (record : Option Record) (attested : Bool) (names : List Nat) : Option Record :=
  if record.isNone && attested then some ⟨1, names⟩ else record

def additions (old new : List Nat) : List Nat :=
  new.filter (fun name => !(old.contains name))

/-- One CAS attempt. A caller retries after an unsuccessful comparison. -/
def attempt (record : Option Record) (expected : Nat) (names : List Nat) : Option Record :=
  match record with
  | none => none
  | some old =>
    if old.revision = expected then
      let added := additions old.names names
      if added.isEmpty then some old
      else some ⟨old.revision + 1, old.names ++ added⟩
    else some old

theorem unattested_initialization_refused (record : Option Record) (names : List Nat) :
    bootstrap record false names = record := by
  simp [bootstrap]

theorem existing_history_not_replaced (record : Record) (attested : Bool) (names : List Nat) :
    bootstrap (some record) attested names = some record := by
  simp [bootstrap]

theorem missing_history_cannot_union (expected : Nat) (names : List Nat) :
    attempt none expected names = none := by
  rfl

theorem stale_compare_changes_nothing (record : Record) (expected : Nat) (names : List Nat)
    (h : record.revision ≠ expected) :
    attempt (some record) expected names = some record := by
  simp [attempt, h]

theorem prior_name_survives (record : Record) (expected name : Nat) (names : List Nat)
    (h : name ∈ record.names) :
    ∃ result, attempt (some record) expected names = some result ∧ name ∈ result.names := by
  simp only [attempt]
  split
  · split
    · exact ⟨record, rfl, h⟩
    · exact ⟨_, rfl, List.mem_append_left _ h⟩
  · exact ⟨record, rfl, h⟩

theorem successful_compare_adds_name (record : Record) (name : Nat) (names : List Nat)
    (hn : name ∈ names) :
    ∃ result, attempt (some record) record.revision names = some result ∧
      name ∈ result.names := by
  by_cases old : name ∈ record.names
  · exact prior_name_survives record record.revision name names old
  · have added : name ∈ additions record.names names := by
      simp [additions, hn, old]
    have nonempty : (additions record.names names).isEmpty = false := by
      cases ha : additions record.names names with
      | nil => simp [ha] at added
      | cons head tail => rfl
    simp [attempt, nonempty, added]

theorem revision_does_not_decrease (record : Record) (expected : Nat) (names : List Nat) :
    ∃ result, attempt (some record) expected names = some result ∧
      record.revision ≤ result.revision := by
  simp only [attempt]
  split
  · split
    · exact ⟨record, rfl, Nat.le_refl _⟩
    · exact ⟨_, rfl, Nat.le_succ _⟩
  · exact ⟨record, rfl, Nat.le_refl _⟩

theorem retry_preserves_both_writers (record : Record) (first second : Nat)
    (firstNames secondNames : List Nat) (hf : first ∈ firstNames) (hs : second ∈ secondNames) :
    ∃ winner final,
      attempt (some record) record.revision firstNames = some winner ∧
      attempt (some winner) winner.revision secondNames = some final ∧
      first ∈ final.names ∧ second ∈ final.names := by
  obtain ⟨winner, hw, hfirst⟩ := successful_compare_adds_name record first firstNames hf
  obtain ⟨final, hfinal, hsecond⟩ := successful_compare_adds_name winner second secondNames hs
  obtain ⟨same, hsame, hstill⟩ := prior_name_survives winner winner.revision first secondNames hfirst
  rw [hfinal] at hsame
  cases hsame
  exact ⟨winner, final, hw, hfinal, hstill, hsecond⟩

/- A trust manager after loading its complete history. `receipt` represents a
   successful write-ahead response from the trusted coordinator; the manager
   itself cannot inspect SQLite or prove that an adapter reports it honestly. -/
structure Manager where
  owner : Nat
  epoch : Nat
  reserved : List Nat
  locallyTrusted : List Nat
  deriving DecidableEq, Repr

def localPermitted (m : Manager) (proposed : List Nat) : Bool :=
  proposed.all (fun name => !(m.reserved.contains name))

def localUpdate (m : Manager) (proposed : List Nat) : Manager :=
  if localPermitted m proposed then { m with locallyTrusted := proposed } else m

private theorem local_denied_when_reserved (m : Manager) (name : Nat) (proposed : List Nat)
    (reserved : name ∈ m.reserved) (member : name ∈ proposed) :
    localPermitted m proposed = false := by
  induction proposed with
  | nil => simp at member
  | cons head tail ih =>
    simp only [List.mem_cons] at member
    cases member with
    | inl eq =>
      subst head
      simp [localPermitted, reserved]
    | inr tailMember =>
      have tailDenied := ih tailMember
      unfold localPermitted at tailDenied ⊢
      rw [List.all_cons, tailDenied]
      simp only [Bool.and_false]

theorem reserved_name_not_added_by_local_update (m : Manager) (name : Nat)
    (proposed : List Nat) (reserved : name ∈ m.reserved) (absent : name ∉ m.locallyTrusted) :
    name ∉ (localUpdate m proposed).locallyTrusted := by
  by_cases member : name ∈ proposed
  · have denied := local_denied_when_reserved m name proposed reserved member
    simp [localUpdate, denied, absent]
  · simp only [localUpdate]
    split <;> simp_all

/-- Provisional names survive a same-manager handoff. The model removes
    conflicting local use; the implementation withdraws the whole generation. -/
def reservePending (m : Manager) (names : List Nat) : Manager :=
  { m with reserved := m.reserved ++ names,
           locallyTrusted := m.locallyTrusted.filter (fun name => !(names.contains name)) }

def handoff (m : Manager) (newOwner : Nat) : Manager :=
  { m with owner := newOwner, epoch := 0 }

theorem pending_name_stays_blocked_after_handoff (m : Manager) (names proposed : List Nat)
    (name newOwner : Nat) (pending : name ∈ names) :
    name ∉ (localUpdate (handoff (reservePending m names) newOwner) proposed).locallyTrusted := by
  apply reserved_name_not_added_by_local_update
  · simp [handoff, reservePending, pending]
  · simp [handoff, reservePending, pending]

def canPublish (m : Manager) (owner epoch : Nat) (receipt : Bool)
    (wall wallBound mono monoBound : Nat) : Bool :=
  decide (m.owner = owner ∧ m.epoch = epoch) && receipt &&
    decide (wall < wallBound) && decide (mono < monoBound)

def publish (m : Manager) (owner epoch : Nat) (receipt : Bool)
    (wall wallBound mono monoBound : Nat) : Manager :=
  if canPublish m owner epoch receipt wall wallBound mono monoBound then
    { m with epoch := m.epoch + 1 }
  else m

theorem no_publication_without_receipt (m : Manager) (owner epoch wall wallBound mono monoBound : Nat) :
    publish m owner epoch false wall wallBound mono monoBound = m := by
  simp [publish, canPublish]

theorem stale_owner_or_epoch_does_not_publish (m : Manager) (owner epoch : Nat) (receipt : Bool)
    (wall wallBound mono monoBound : Nat) (stale : m.owner ≠ owner ∨ m.epoch ≠ epoch) :
    publish m owner epoch receipt wall wallBound mono monoBound = m := by
  simp [publish, canPublish]
  intro ho he
  exact (stale.elim (fun h => h ho) (fun h => h he)).elim

theorem elapsed_wait_does_not_publish (m : Manager) (owner epoch : Nat) (receipt : Bool)
    (wall wallBound mono monoBound : Nat) (elapsed : wallBound ≤ wall ∨ monoBound ≤ mono) :
    publish m owner epoch receipt wall wallBound mono monoBound = m := by
  simp only [publish, canPublish]
  split
  · rename_i accepted
    simp only [Bool.and_eq_true, decide_eq_true_eq] at accepted
    have wallLive : wall < wallBound := accepted.1.2
    have monoLive : mono < monoBound := accepted.2
    cases elapsed with
    | inl h => exact False.elim (Nat.not_lt_of_ge h wallLive)
    | inr h => exact False.elim (Nat.not_lt_of_ge h monoLive)
  · rfl

/-- A provisionally installed generation remains bounded until finalization. -/
def provisionalUsable (expired : Bool) (wall wallBound mono monoBound : Nat) : Bool :=
  !expired && decide (wall < wallBound) && decide (mono < monoBound)

def finalizePermitted (expired : Bool) (wall wallBound mono monoBound : Nat) : Bool :=
  provisionalUsable expired wall wallBound mono monoBound

theorem elapsed_provisional_generation_not_usable (expired : Bool)
    (wall wallBound mono monoBound : Nat) (elapsed : wallBound ≤ wall ∨ monoBound ≤ mono) :
    provisionalUsable expired wall wallBound mono monoBound = false := by
  cases elapsed with
  | inl h => simp [provisionalUsable, Nat.not_lt_of_ge h]
  | inr h => simp [provisionalUsable, Nat.not_lt_of_ge h]

theorem observed_provisional_expiry_cannot_finalize (wall wallBound mono monoBound : Nat) :
    finalizePermitted true wall wallBound mono monoBound = false := by
  simp [finalizePermitted, provisionalUsable]

/- One process-local trust owner. A pending write represents an operation
   whose completion has not yet been observed. Poison is permanent within the
   process; cross-process writers and database rollback are not modeled. -/
structure Coordination where
  manager : Bool
  pending : Nat
  poisoned : Bool
  deriving DecidableEq, Repr

def successorMayClaim (c : Coordination) : Bool :=
  !c.manager && decide (c.pending = 0) && !c.poisoned

def retireManager (c : Coordination) : Coordination := { c with manager := false }

def abortPending (c : Coordination) : Coordination :=
  { c with pending := c.pending - 1, poisoned := true }

theorem pending_write_blocks_reconstruction (c : Coordination) (h : c.pending ≠ 0) :
    successorMayClaim c = false := by
  simp [successorMayClaim, h]

theorem retirement_does_not_forget_a_pending_write (c : Coordination) (h : c.pending ≠ 0) :
    successorMayClaim (retireManager c) = false := by
  simp [successorMayClaim, retireManager, h]

theorem unknown_write_outcome_fences_successor (c : Coordination) :
    successorMayClaim (abortPending c) = false := by
  simp [successorMayClaim, abortPending]

/- An abstract cooperative OS lease. The model assumes the filesystem and
   supported writers agree on one resource; it does not prove OS locking,
   filesystem identity, raw-writer cooperation, or crash recovery. -/
inductive FileClaim where
  | acquired (owner : Nat)
  | refused (owner : Nat)
  deriving DecidableEq, Repr

def claimFile (owner : Option Nat) (candidate : Nat) : FileClaim :=
  match owner with
  | none => .acquired candidate
  | some held => .refused held

def fileProcessExit (owner : Option Nat) (exiting : Nat) : Option Nat :=
  match owner with
  | none => none
  | some held => if held = exiting then none else some held

theorem occupied_file_claim_refused (owner candidate : Nat) :
    claimFile (some owner) candidate = .refused owner := by
  rfl

theorem unrelated_exit_preserves_file_owner (owner exiting : Nat) (different : owner ≠ exiting) :
    fileProcessExit (some owner) exiting = some owner := by
  simp [fileProcessExit, different]

/- The stream gate models only events the source loop has actually observed.
   It does not claim knowledge of a remote event that has not been delivered. -/
structure StreamGate where
  pending : Option Nat
  published : Option Nat
  deriving DecidableEq, Repr

def observeNewEvent (gate : StreamGate) : StreamGate := { gate with pending := none }

def finishPending (gate : StreamGate) (token : Nat) : StreamGate :=
  if gate.pending = some token then { gate with pending := none, published := some token }
  else gate

theorem observed_event_supersedes_prior_result (gate : StreamGate) (token : Nat) :
    finishPending (observeNewEvent gate) token = observeNewEvent gate := by
  simp [finishPending, observeNewEvent]

def mayStartWrite (limit active : Nat) : Bool := decide (active < limit)

theorem saturated_write_capacity_refuses (limit active : Nat) (full : limit ≤ active) :
    mayStartWrite limit active = false := by
  simp [mayStartWrite, Nat.not_lt_of_ge full]

/- Stored-profile adoption is modeled for a nonempty valid stored set. The
   manager's conditional swap is the linearization point; the model does not
   prove cross-process atomicity between a store read and a manager swap. -/
def effectiveStored (reserved stored : List Nat) : List Nat :=
  stored.filter (fun name => !(reserved.contains name))

theorem reserved_stored_name_is_quarantined (reserved stored : List Nat) (name : Nat)
    (h : name ∈ reserved) : name ∉ effectiveStored reserved stored := by
  simp [effectiveStored, h]

def refreshRequired (stored active : Nat) (last current : Option Nat) (due : Bool) : Bool :=
  decide (active ≤ stored) &&
    (decide (stored ≠ active) || due || decide (last ≠ current))

theorem changed_generation_requires_reconciliation (revision before after : Nat)
    (h : before ≠ after) :
    refreshRequired revision revision (some before) (some after) false = true := by
  simp [refreshRequired, h]

def conditionalGeneration (expected current candidate : Nat) : Nat :=
  if expected = current then candidate else current

theorem stale_merge_cannot_replace_new_generation (expected current candidate : Nat)
    (h : expected ≠ current) : conditionalGeneration expected current candidate = current := by
  simp [conditionalGeneration, h]

private def bit (value : Bool) : String := if value then "1" else "0"

def main : IO Unit := do
  for initial in [[], [0], [0, 1]] do
    for incoming in [[], [1], [1, 2]] do
      let start := bootstrap none true initial
      let result := attempt start 1 incoming
      match result with
      | none => IO.println "unexpected-missing"
      | some record =>
        IO.println s!"case\t{bit (initial.contains 0)}{bit (initial.contains 1)}{bit (initial.contains 2)}\t{bit (incoming.contains 0)}{bit (incoming.contains 1)}{bit (incoming.contains 2)}\t{record.revision}\t{bit (record.names.contains 0)}{bit (record.names.contains 1)}{bit (record.names.contains 2)}"
  for observed in [false, true] do
    let initial : StreamGate := ⟨some 1, none⟩
    let current := if observed then observeNewEvent initial else initial
    let result := finishPending current 1
    IO.println s!"stream\t{bit observed}\t{bit (result.published.isSome)}"
  for pending in [false, true] do
    for poisoned in [false, true] do
      let c : Coordination := ⟨false, if pending then 1 else 0, poisoned⟩
      IO.println s!"coord\t{bit pending}\t{bit poisoned}\t{bit (successorMayClaim c)}"
  for occupied in [false, true] do
    let claim := claimFile (if occupied then some 1 else none) 2
    let acquired := match claim with
      | .acquired _ => true
      | .refused _ => false
    IO.println s!"file\t{bit occupied}\t{bit acquired}"
  for reserved in [false, true] do
    for rotated in [false, true] do
      let sourceNames := if reserved then [1] else []
      let effective := effectiveStored sourceNames [1, 2]
      let current := if rotated then some 2 else some 1
      IO.println s!"lifecycle\t{bit reserved}\t{bit rotated}\t{bit (effective.contains 1)}\t{bit (effective.contains 2)}\t{bit (refreshRequired 1 1 (some 1) current false)}"

end OpenSesame.SourceTrustHistory

def main : IO Unit := OpenSesame.SourceTrustHistory.main
