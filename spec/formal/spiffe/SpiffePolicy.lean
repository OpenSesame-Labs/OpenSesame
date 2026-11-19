import Lean

set_option autoImplicit false

namespace OpenSesame.SpiffePolicy

inductive Signal where
  | noIdentity | permissionDenied | missingSvids | missingBundle
  | transport | unauthenticated | emptyResponse | malformedField | invalidField
  deriving DecidableEq, Repr

inductive Decision where
  | noIdentity | permissionDenied | missingSvids | missingBundle | outage | malformed
  deriving DecidableEq, Repr

def classify : Signal → Decision
  | .noIdentity => .noIdentity
  | .permissionDenied | .unauthenticated => .permissionDenied
  | .missingSvids => .missingSvids
  | .missingBundle => .missingBundle
  | .transport | .emptyResponse => .outage
  | .malformedField | .invalidField => .malformed

inductive Phase where
  | active | withdrawn
  deriving DecidableEq, Repr

inductive Event where
  | activated | rejected (trustPreserved : Bool) | failure (decision : Decision)
  deriving DecidableEq, Repr

def step (phase : Phase) : Event → Phase
  | .activated => .active
  | .rejected true => phase
  | .rejected false => .withdrawn
  | .failure .outage => phase
  | .failure _ => .withdrawn

theorem no_identity_withdraws (phase : Phase) :
    step phase (.failure (classify .noIdentity)) = .withdrawn := rfl

theorem permission_denial_withdraws (phase : Phase) :
    step phase (.failure (classify .permissionDenied)) = .withdrawn := rfl

theorem empty_snapshot_withdraws (phase : Phase) :
    step phase (.failure (classify .missingSvids)) = .withdrawn := rfl

theorem missing_bundle_withdraws (phase : Phase) :
    step phase (.failure (classify .missingBundle)) = .withdrawn := rfl

theorem malformed_snapshot_withdraws (phase : Phase) :
    step phase (.failure (classify .malformedField)) = .withdrawn := rfl

theorem transient_transport_is_outage : classify .transport = .outage := rfl

theorem unauthenticated_withdraws (phase : Phase) :
    step phase (.failure (classify .unauthenticated)) = .withdrawn := rfl

theorem outage_preserves_active : step .active (.failure (classify .transport)) = .active := rfl

theorem rejected_preserved_trust_keeps_active : step .active (.rejected true) = .active := rfl

theorem only_activation_recovers (event : Event) (h : event ≠ .activated) :
    step .withdrawn event = .withdrawn := by
  cases event with
  | activated => contradiction
  | rejected preserved => cases preserved <;> rfl
  | failure decision => cases decision <;> rfl

def trustPreserved (previous incoming : Nat) : Bool :=
  (!(previous.testBit 0) || incoming.testBit 0) &&
  (!(previous.testBit 1) || incoming.testBit 1) &&
  (!(previous.testBit 2) || incoming.testBit 2)

theorem missing_anchor_withdraws (previous incoming : Nat)
    (oldHas : previous.testBit 0 = true) (missing : incoming.testBit 0 = false) :
    step .active (.rejected (trustPreserved previous incoming)) = .withdrawn := by
  simp [trustPreserved, oldHas, missing, step]

theorem missing_second_anchor_withdraws (previous incoming : Nat)
    (oldHas : previous.testBit 1 = true) (missing : incoming.testBit 1 = false) :
    step .active (.rejected (trustPreserved previous incoming)) = .withdrawn := by
  simp [trustPreserved, oldHas, missing, step]

theorem missing_third_anchor_withdraws (previous incoming : Nat)
    (oldHas : previous.testBit 2 = true) (missing : incoming.testBit 2 = false) :
    step .active (.rejected (trustPreserved previous incoming)) = .withdrawn := by
  simp [trustPreserved, oldHas, missing, step]

def outageDeadline (notAfter since maxStale : Nat) : Nat :=
  min notAfter (since + maxStale)

def retryDeadline (notAfter previous since maxStale : Nat) : Nat :=
  min previous (outageDeadline notAfter since maxStale)

def effectiveDeadline (notAfter retainUntil : Nat) : Nat := min notAfter retainUntil

def usableAt (now deadline : Nat) : Bool := decide (now < deadline)

theorem outage_bounded_by_certificate (notAfter since maxStale : Nat) :
    outageDeadline notAfter since maxStale ≤ notAfter := by
  exact Nat.min_le_left _ _

theorem outage_bounded_by_freshness (notAfter since maxStale : Nat) :
    outageDeadline notAfter since maxStale ≤ since + maxStale := by
  exact Nat.min_le_right _ _

theorem retry_cannot_extend_deadline (notAfter previous since maxStale : Nat) :
    retryDeadline notAfter previous since maxStale ≤ previous := by
  exact Nat.min_le_left _ _

theorem effective_bounded_by_certificate (notAfter retainUntil : Nat) :
    effectiveDeadline notAfter retainUntil ≤ notAfter := by
  exact Nat.min_le_left _ _

theorem effective_bounded_by_retention (notAfter retainUntil : Nat) :
    effectiveDeadline notAfter retainUntil ≤ retainUntil := by
  exact Nat.min_le_right _ _

theorem expired_is_not_usable (now deadline : Nat) (h : deadline ≤ now) :
    usableAt now deadline = false := by
  simp [usableAt, Nat.not_lt.mpr h]

theorem status_expired_at_retention (now notAfter retainUntil : Nat)
    (h : retainUntil ≤ now) : usableAt now (effectiveDeadline notAfter retainUntil) = false := by
  exact expired_is_not_usable _ _ (Nat.le_trans (effective_bounded_by_retention _ _) h)

theorem status_expired_at_certificate (now notAfter retainUntil : Nat)
    (h : notAfter ≤ now) : usableAt now (effectiveDeadline notAfter retainUntil) = false := by
  exact expired_is_not_usable _ _ (Nat.le_trans (effective_bounded_by_certificate _ _) h)

private def signals : List (String × Signal) := [
  ("no_identity", .noIdentity), ("permission_denied", .permissionDenied),
  ("missing_svids", .missingSvids), ("missing_bundle", .missingBundle),
  ("transport", .transport), ("unauthenticated", .unauthenticated),
  ("empty_response", .emptyResponse), ("malformed_field", .malformedField),
  ("invalid_field", .invalidField)]

private def decisionName : Decision → String
  | .noIdentity => "no_identity"
  | .permissionDenied => "permission_denied"
  | .missingSvids => "missing_svids"
  | .missingBundle => "missing_bundle"
  | .outage => "outage"
  | .malformed => "malformed"

private def bit (b : Bool) : String := if b then "1" else "0"
private def ticks : List Nat := [0, 1, 5, 10]

def main : IO Unit := do
  for (name, signal) in signals do
    IO.println s!"classify\t{name}\t{decisionName (classify signal)}"
  for previous in List.range 8 do
    for incoming in List.range 8 do
      IO.println s!"trust\t{previous}\t{incoming}\t{bit (trustPreserved previous incoming)}"
  for notAfter in ticks do
    for since in ticks do
      for maxStale in ticks do
        IO.println s!"deadline\t{notAfter}\t{since}\t{maxStale}\t{outageDeadline notAfter since maxStale}"
        for previous in ticks do
          IO.println s!"retry\t{notAfter}\t{previous}\t{since}\t{maxStale}\t{retryDeadline notAfter previous since maxStale}"
      IO.println s!"effective\t{notAfter}\t{since}\t{effectiveDeadline notAfter since}"
      for now in ticks do
        IO.println s!"status\t{notAfter}\t{since}\t{now}\t{bit (usableAt now (effectiveDeadline notAfter since))}"

end OpenSesame.SpiffePolicy

def main : IO Unit := OpenSesame.SpiffePolicy.main
