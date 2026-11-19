import Lean

set_option autoImplicit false

namespace OpenSesame.SourceLifetime

structure Fence where
  owner : Nat
  epoch : Nat
  deadline : Option Nat
  expired : Bool
  deriving DecidableEq, Repr

structure State where
  generation : Nat
  managed : Bool
  fence : Option Fence
  withdrawn : Bool
  retired : List Nat
  deriving DecidableEq, Repr

def owns (s : State) (owner epoch : Nat) : Bool :=
  match s.fence with
  | none => false
  | some f => decide (f.owner = owner ∧ f.epoch = epoch)

def usable (s : State) (now : Nat) : Bool :=
  if s.withdrawn then false
  else match s.fence with
    | none => !s.managed
    | some f => match f.deadline with
      | none => false
      | some deadline => !f.expired && decide (now < deadline)

def observe (s : State) (now : Nat) : State :=
  if s.withdrawn then s
  else match s.fence with
    | none => s
    | some f => match f.deadline with
      | none => s
      | some deadline =>
        if f.expired || decide (deadline ≤ now) then
          { s with fence := some { f with expired := true } }
        else s

def fenceIdentity (f : Option Fence) : Option (Nat × Nat × Option Nat) :=
  f.map (fun value => (value.owner, value.epoch, value.deadline))

def latched (s : State) : Bool := s.fence.any (fun f => f.expired)

inductive Action where
  | claim (owner expectedGeneration : Nat)
  | activate (owner epoch deadline : Nat)
  | tighten (owner epoch deadline : Nat)
  | withdraw (owner epoch : Nat)
  | retire (owner epoch : Nat)
  | ordinary (sameIdentity sameTrust : Bool) (now : Nat)
  deriving DecidableEq, Repr

def isActivation : Action → Bool
  | .activate _ _ _ => true
  | _ => false

def step (s : State) : Action → State
  | .claim owner expected =>
    if s.fence.isNone && !(s.retired.contains owner) && decide (s.generation = expected) then
      let next := s.generation + 1
      { s with generation := next, managed := true, withdrawn := true, fence := some ⟨owner, next, none, false⟩ }
    else s
  | .activate owner epoch deadline =>
    if owns s owner epoch then
      let next := s.generation + 1
      { s with generation := next, withdrawn := false, fence := some ⟨owner, next, some deadline, false⟩ }
    else s
  | .tighten owner epoch deadline =>
    if owns s owner epoch then
      match s.fence with
      | some f => match f.deadline with
        | some old => { s with fence := some { f with deadline := some (min old deadline) } }
        | none => s
      | none => s
    else s
  | .withdraw owner epoch =>
    -- Model the first withdrawal; changed reasons on an already-withdrawn
    -- generation are deliberately outside this Boolean-reason abstraction.
    if owns s owner epoch then
      if s.withdrawn then s else { s with generation := s.generation + 1, withdrawn := true }
    else s
  | .retire owner epoch =>
    if owns s owner epoch then
      { s with generation := s.generation + 1, withdrawn := true, fence := none, managed := true, retired := owner :: s.retired }
    else s
  | .ordinary sameIdentity sameTrust now =>
    let checked := if s.managed then observe s now else s
    if !s.managed || (sameIdentity && sameTrust && usable checked now) then
      { checked with generation := checked.generation + 1, withdrawn := false }
    else checked

theorem claim_quarantines (s : State) (owner expected : Nat)
    (hf : s.fence = none) (hr : owner ∉ s.retired) (hg : s.generation = expected) :
    (step s (.claim owner expected)).withdrawn = true := by
  simp [step, hf, hr, hg]

theorem stale_owner_or_epoch_cannot_change (s : State) (owner epoch deadline : Nat)
    (h : owns s owner epoch = false) :
    step s (.activate owner epoch deadline) = s ∧
    step s (.tighten owner epoch deadline) = s ∧
    step s (.withdraw owner epoch) = s ∧
    step s (.retire owner epoch) = s := by
  simp [step, h]

theorem tightening_keeps_the_earlier_deadline (s : State) (f : Fence)
    (owner epoch old requested : Nat) (hf : s.fence = some f)
    (ho : owns s owner epoch = true) (hd : f.deadline = some old) :
    (step s (.tighten owner epoch requested)).fence =
      some { f with deadline := some (min old requested) } := by
  simp [step, ho, hf, hd]

theorem withdrawn_is_not_usable (s : State) (now : Nat) (h : s.withdrawn = true) :
    usable s now = false := by
  simp [usable, h]

theorem reserved_is_not_usable (s : State) (f : Fence) (now : Nat)
    (hf : s.fence = some f) (hd : f.deadline = none) : usable s now = false := by
  simp [usable, hf, hd]

theorem deadline_is_inclusive (s : State) (f : Fence) (deadline now : Nat)
    (hf : s.fence = some f) (hd : f.deadline = some deadline) (h : deadline ≤ now) :
    usable s now = false := by
  simp [usable, hf, hd, Nat.not_lt.mpr h]

theorem observed_expiry_stays_unusable (s : State) (f : Fence) (deadline now earlier : Nat)
    (hw : s.withdrawn = false) (hf : s.fence = some f)
    (hd : f.deadline = some deadline) (h : deadline ≤ now) :
    usable (observe s now) earlier = false := by
  simp [observe, usable, hw, hf, hd, h]

theorem ordinary_cannot_reset_fence (s : State) (same trust : Bool) (now : Nat) :
    fenceIdentity (step s (.ordinary same trust now)).fence = fenceIdentity s.fence ∧
    (s.managed = true → trust = false → (step s (.ordinary same trust now)).generation = s.generation) ∧
    (s.managed = true → same = false → (step s (.ordinary same trust now)).generation = s.generation) := by
  constructor
  · simp only [step]
    repeat
      first | split | simp_all [observe, fenceIdentity]
  · constructor
    · intro hm ht
      simp [step, hm, ht]
      repeat
        first | split | simp_all [observe]
    · intro hm hs
      simp [step, hm, hs]
      repeat
        first | split | simp_all [observe]

-- These three operations keep the current fence; retirement removes it and
-- a new source activation may establish a fresh fence.
theorem latched_survives_nonactivation (s : State) (owner epoch deadline : Nat)
    (same trust : Bool) (now : Nat) (h : latched s = true) :
    latched (step s (.tighten owner epoch deadline)) = true ∧
    latched (step s (.withdraw owner epoch)) = true ∧
    latched (step s (.ordinary same trust now)) = true := by
  simp only [step]
  repeat
    first | constructor | split | simp_all [latched, observe]

theorem quarantine_blocks_ordinary (s : State) (same trust : Bool) (now : Nat)
    (hm : s.managed = true) (hw : s.withdrawn = true) :
    step s (.ordinary same trust now) = s := by
  simp [step, observe, usable, hm, hw]

theorem retired_owner_cannot_claim (s : State) (owner expected : Nat)
    (h : owner ∈ s.retired) : step s (.claim owner expected) = s := by
  simp [step, h]

theorem only_activation_recovers (s : State) (action : Action)
    (hm : s.managed = true) (hw : s.withdrawn = true) (ha : isActivation action = false) :
    (step s action).withdrawn = true := by
  cases action with
  | activate owner epoch deadline => simp [isActivation] at ha
  | claim owner expected =>
    simp only [step]
    split <;> simp [hw]
  | tighten owner epoch deadline =>
    simp only [step]
    split
    · cases s.fence with
      | none => simp [hw]
      | some f =>
        cases hd : f.deadline with
        | none => simp [hd, hw]
        | some d => simp [hd, hw]
    · simp [hw]
  | withdraw owner epoch =>
    simp only [step]
    split <;> simp [hw]
  | retire owner epoch =>
    simp only [step]
    split <;> simp [hw]
  | ordinary same trust now =>
    simp [step, observe, usable, hm, hw]

private def bit (value : Bool) : String := if value then "1" else "0"

def main : IO Unit := do
  let base : State := ⟨1, false, none, false, []⟩
  let reserved := step base (.claim 1 1)
  IO.println s!"claim\t{bit reserved.withdrawn}\t{bit (usable reserved 0)}"
  let active := step reserved (.activate 1 2 10)
  for owner in [1, 2] do
    for epoch in [2, 3] do
      let changed := step active (.tighten owner epoch 5)
      let withdrew := step active (.withdraw owner epoch)
      let retired := step active (.retire owner epoch)
      IO.println s!"fence\t{owner}\t{epoch}\t{bit (changed != active)}\t{bit withdrew.withdrawn}\t{withdrew.generation}\t{bit retired.withdrawn}\t{retired.generation}"
  for deadline in [1, 5, 10] do
    for now in [0, 1, 5, 10] do
      let candidate := step reserved (.activate 1 2 deadline)
      IO.println s!"usable\t{deadline}\t{now}\t{bit (usable candidate now)}"
  for same in [false, true] do
    for trust in [false, true] do
      for now in [5, 10] do
        let result := step active (.ordinary same trust now)
        let latched := result.fence.any (fun f => f.expired)
        IO.println s!"ordinary\t{bit same}\t{bit trust}\t{now}\t{result.generation}\t{bit latched}"

end OpenSesame.SourceLifetime

def main : IO Unit := OpenSesame.SourceLifetime.main
