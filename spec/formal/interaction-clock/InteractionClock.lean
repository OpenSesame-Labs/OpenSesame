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

def instants : List Instant :=
  [⟨false, 0⟩, ⟨true, -8640000000000000⟩, ⟨true, -1⟩,
   ⟨true, 0⟩, ⟨true, 1⟩, ⟨true, 8640000000000000⟩]

def printVectors : IO Unit := do
  for deadline in instants do
    for now in instants do
      IO.println s!"{deadline.valid}\t{deadline.millis}\t{now.valid}\t{now.millis}\t{liveAt deadline now}"

end OpenSesame.InteractionClock

def main : IO Unit := OpenSesame.InteractionClock.printVectors
