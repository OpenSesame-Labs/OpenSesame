/- These theorem types are independently required by the verification command. -/
open OpenSesame.InteractionClock

#require_theorem OpenSesame.InteractionClock.live_refines_policy :
  ∀ (deadline now : Instant), liveAt deadline now = true ↔ policy deadline now

#require_theorem OpenSesame.InteractionClock.invalid_deadline_denied :
  ∀ (deadline now : Instant) (_invalid : deadline.valid = false),
    liveAt deadline now = false

#require_theorem OpenSesame.InteractionClock.invalid_clock_denied :
  ∀ (deadline now : Instant) (_invalid : now.valid = false),
    liveAt deadline now = false

#require_theorem OpenSesame.InteractionClock.expired_at_sample_denied :
  ∀ (deadline now : Instant) (_expired : deadline.millis ≤ now.millis),
    liveAt deadline now = false

#require_theorem OpenSesame.InteractionClock.approval_requires_both_live :
  ∀ (interactionDeadline activationDeadline now : Instant),
    finalApproval interactionDeadline activationDeadline now = true ↔
      policy interactionDeadline now ∧ policy activationDeadline now

#require_theorem OpenSesame.InteractionClock.expired_interaction_blocks_final_approval :
  ∀ (interactionDeadline activationDeadline now : Instant)
    (_expired : interactionDeadline.millis ≤ now.millis),
    finalApproval interactionDeadline activationDeadline now = false

#require_theorem OpenSesame.InteractionClock.expired_activation_blocks_final_approval :
  ∀ (interactionDeadline activationDeadline now : Instant)
    (_expired : activationDeadline.millis ≤ now.millis),
    finalApproval interactionDeadline activationDeadline now = false

#require_theorem OpenSesame.InteractionClock.activation_completion_requires_both_live :
  ∀ (interactionDeadline activationDeadline now : Instant),
    finalActivation interactionDeadline activationDeadline now = true ↔
      policy interactionDeadline now ∧ policy activationDeadline now

#require_theorem OpenSesame.InteractionClock.settlement_requires_every_stage_live :
  ∀ (deadline consumed reservation dispatched identity committed effect : Instant),
    finalSettlement deadline consumed reservation dispatched identity committed effect = true ↔
      policy deadline consumed ∧
      policy deadline reservation ∧
      policy deadline dispatched ∧
      policy deadline identity ∧
      policy deadline committed ∧
      policy deadline effect

#require_theorem OpenSesame.InteractionClock.uow_commit_requires_every_sample_live :
  ∀ (crossing : Option Nat) (_h : (uowOutcome crossing).2.1 = true),
    ∀ b ∈ samplesLive crossing, b = true

#require_theorem OpenSesame.InteractionClock.uow_refusal_persists_nothing :
  ∀ (crossing : Option Nat) (_h : (uowOutcome crossing).1 = 410),
    (uowOutcome crossing).2 = (false, 0)

#require_theorem OpenSesame.InteractionClock.uow_crossing_at_any_sample_refuses :
  ∀ (k : Nat) (_hk : k < stageSamples), uowOutcome (some k) = (410, false, 0)

#require_theorem OpenSesame.InteractionClock.uow_crossing_after_last_sample_commits :
  uowOutcome (some stageSamples) = (200, true, 1)
