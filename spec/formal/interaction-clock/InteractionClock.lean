import Lean

set_option autoImplicit false

namespace OpenSesame.InteractionClock

/-- Invalid JavaScript dates have no usable timestamp. -/
structure Instant where
  valid : Bool
  millis : Int

def liveAt (deadline now : Instant) : Bool :=
  deadline.valid && now.valid && decide (now.millis < deadline.millis)

def policy (deadline now : Instant) : Prop :=
  deadline.valid = true ∧ now.valid = true ∧ now.millis < deadline.millis

theorem live_refines_policy (deadline now : Instant) :
    liveAt deadline now = true ↔ policy deadline now := by
  simp [liveAt, policy, and_assoc]

theorem invalid_deadline_denied (deadline now : Instant)
    (invalid : deadline.valid = false) : liveAt deadline now = false := by
  simp [liveAt, invalid]

theorem invalid_clock_denied (deadline now : Instant)
    (invalid : now.valid = false) : liveAt deadline now = false := by
  simp [liveAt, invalid]

theorem expired_at_sample_denied (deadline now : Instant)
    (expired : deadline.millis ≤ now.millis) : liveAt deadline now = false := by
  simp [liveAt, expired]

/-- Only the time checks; identity, proof binding, and storage are outside this model. -/
def finalApproval (interactionDeadline activationDeadline now : Instant) : Bool :=
  liveAt interactionDeadline now && liveAt activationDeadline now

theorem approval_requires_both_live (interactionDeadline activationDeadline now : Instant) :
    finalApproval interactionDeadline activationDeadline now = true ↔
      policy interactionDeadline now ∧ policy activationDeadline now := by
  simp [finalApproval, live_refines_policy]

/-- Activation completion uses the same pair of sampled deadline checks. -/
def finalActivation (interactionDeadline activationDeadline now : Instant) : Bool :=
  finalApproval interactionDeadline activationDeadline now

theorem activation_completion_requires_both_live
    (interactionDeadline activationDeadline now : Instant) :
    finalActivation interactionDeadline activationDeadline now = true ↔
      policy interactionDeadline now ∧ policy activationDeadline now := by
  exact approval_requires_both_live interactionDeadline activationDeadline now

theorem expired_interaction_blocks_final_approval
    (interactionDeadline activationDeadline now : Instant)
    (expired : interactionDeadline.millis ≤ now.millis) :
    finalApproval interactionDeadline activationDeadline now = false := by
  simp [finalApproval, expired_at_sample_denied interactionDeadline now expired]

theorem expired_activation_blocks_final_approval
    (interactionDeadline activationDeadline now : Instant)
    (expired : activationDeadline.millis ≤ now.millis) :
    finalApproval interactionDeadline activationDeadline now = false := by
  simp [finalApproval, expired_at_sample_denied activationDeadline now expired]

/--
Settlement is admitted only when the interaction is live at every sample taken
between awaited transactional stages. Database commit atomicity is outside this
model; each argument is an application-clock observation.
-/
def finalSettlement
    (deadline consumed reservation dispatched identity committed effect : Instant) : Bool :=
  liveAt deadline consumed &&
    (liveAt deadline reservation &&
      (liveAt deadline dispatched &&
        (liveAt deadline identity &&
          (liveAt deadline committed && liveAt deadline effect))))

theorem settlement_requires_every_stage_live
    (deadline consumed reservation dispatched identity committed effect : Instant) :
    finalSettlement deadline consumed reservation dispatched identity committed effect = true ↔
      policy deadline consumed ∧
      policy deadline reservation ∧
      policy deadline dispatched ∧
      policy deadline identity ∧
      policy deadline committed ∧
      policy deadline effect := by
  simp [finalSettlement, live_refines_policy]

/-!
CLOCK-1 at the unit of work. `consumeAndSettle` (interaction-settlement.ts) runs
inside `ctx.repos.transaction` (interaction-handoff.ts) and takes six application
samples, each before the next staged write; a refused sample throws and the
transaction rolls back. `crossing = some k` means the deadline passes just before
sample `k` (`k = 6`: after the last sample, before the commit); `none` means never.
The outcome is (HTTP status, interaction stored as consumed, committed fences).
Rollback of staged writes is the transaction's contract, checked by the replay.
-/
def stageSamples : Nat := 6

def samplesLive (crossing : Option Nat) : List Bool :=
  (List.range stageSamples).map fun i =>
    match crossing with
    | some k => decide (i < k)
    | none => true

def uowOutcome (crossing : Option Nat) : Nat × Bool × Nat :=
  if (samplesLive crossing).all id then (200, true, 1) else (410, false, 0)

theorem uow_commit_requires_every_sample_live (crossing : Option Nat)
    (h : (uowOutcome crossing).2.1 = true) : ∀ b ∈ samplesLive crossing, b = true := by
  unfold uowOutcome at h
  split at h
  · rename_i all; exact fun b mem => by simpa using List.all_eq_true.1 all b mem
  · cases h

theorem uow_refusal_persists_nothing (crossing : Option Nat)
    (h : (uowOutcome crossing).1 = 410) : (uowOutcome crossing).2 = (false, 0) := by
  unfold uowOutcome at h ⊢
  split <;> simp_all

theorem uow_crossing_at_any_sample_refuses (k : Nat) (hk : k < stageSamples) :
    uowOutcome (some k) = (410, false, 0) := by
  unfold stageSamples at hk
  have : k = 0 ∨ k = 1 ∨ k = 2 ∨ k = 3 ∨ k = 4 ∨ k = 5 := by omega
  rcases this with h | h | h | h | h | h <;> subst h <;> rfl

/-- The residual window, stated rather than hidden: a deadline that passes after
the last application sample and before the database commit is not refused. -/
theorem uow_crossing_after_last_sample_commits : uowOutcome (some stageSamples) = (200, true, 1) :=
  rfl

def instants : List Instant :=
  [⟨false, 0⟩, ⟨true, -8640000000000000⟩, ⟨true, -1⟩,
   ⟨true, 0⟩, ⟨true, 1⟩, ⟨true, 8640000000000000⟩]

def printVectors : IO Unit := do
  for deadline in instants do
    for now in instants do
      IO.println s!"{deadline.valid}\t{deadline.millis}\t{now.valid}\t{now.millis}\t{liveAt deadline now}"
  for interactionDeadline in instants do
    for activationDeadline in instants do
      for now in instants do
        IO.println s!"activation\t{interactionDeadline.valid}\t{interactionDeadline.millis}\t{activationDeadline.valid}\t{activationDeadline.millis}\t{now.valid}\t{now.millis}\t{finalActivation interactionDeadline activationDeadline now}"
  let crossings : List (Option Nat) := (List.range (stageSamples + 1)).map some ++ [none]
  for crossing in crossings do
    let (status, consumed, commits) := uowOutcome crossing
    let label := match crossing with | some k => toString k | none => "none"
    IO.println s!"uow\t{label}\t{status}\t{if consumed then "consumed" else "approved"}\t{commits}"

end OpenSesame.InteractionClock

def main : IO Unit := OpenSesame.InteractionClock.printVectors
