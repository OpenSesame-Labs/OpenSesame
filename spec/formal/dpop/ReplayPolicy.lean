import Lean

set_option autoImplicit false

namespace OpenSesame.DpopReplay

inductive Decision where
  | accepted | invalid | replay | capacity
  deriving DecidableEq, Repr

def intMin : Int := -9223372036854775808
def intMax : Int := 9223372036854775807

def saturatingAdd (left right : Int) : Int :=
  max intMin (min intMax (left + right))

def prune (seenUntil : Option Int) (now : Int) : Option Int :=
  match seenUntil with
  | none => none
  | some retainTo => if now ≤ retainTo then some retainTo else none

def record (seenUntil : Option Int) (now ttl validUntil : Int)
    (capacity length otherCount : Nat) : Decision × Option Int :=
  if length == 0 || length > 256 then (.invalid, seenUntil)
  else
    let existing := prune seenUntil now
    if existing.isSome then (.replay, existing)
    else if capacity ≤ otherCount then (.capacity, none)
    else (.accepted, some (max (saturatingAdd now ttl) validUntil))

-- An accepted insertion, fresh or replacing an expired entry, retains at least through validUntil.
theorem insertion_retains_until_valid_end
    (seen : Option Int) (now ttl validUntil : Int)
    (capacity length otherCount : Nat)
    (h : (record seen now ttl validUntil capacity length otherCount).1 = .accepted) :
    ∃ retainTo,
      (record seen now ttl validUntil capacity length otherCount).2 = some retainTo ∧
      validUntil ≤ retainTo := by
  by_cases hInvalid : length == 0 || length > 256
  · simp [record, hInvalid] at h
  · cases seen with
    | none =>
        by_cases hFull : capacity ≤ otherCount
        · simp [record, prune, hInvalid, hFull] at h
        · refine ⟨max (saturatingAdd now ttl) validUntil, ?_, Int.le_max_right _ _⟩
          simp [record, prune, hInvalid, hFull]
    | some previous =>
        by_cases hLive : now ≤ previous
        · simp [record, prune, hInvalid, hLive] at h
        · by_cases hFull : capacity ≤ otherCount
          · simp [record, prune, hInvalid, hLive, hFull] at h
          · refine ⟨max (saturatingAdd now ttl) validUntil, ?_, Int.le_max_right _ _⟩
            simp [record, prune, hInvalid, hLive, hFull]

theorem accepted_first_remembers (now ttl validUntil : Int)
    (capacity length otherCount : Nat)
    (h : (record none now ttl validUntil capacity length otherCount).1 = .accepted) :
    ∃ retainTo, (record none now ttl validUntil capacity length otherCount).2 = some retainTo ∧
      validUntil ≤ retainTo :=
  insertion_retains_until_valid_end none now ttl validUntil capacity length otherCount h

theorem prune_keeps_live_entry (retainTo validUntil now : Int)
    (hUntil : validUntil ≤ retainTo) (hNow : now ≤ validUntil) :
    prune (some retainTo) now = some retainTo := by
  have h : now ≤ retainTo := Int.le_trans hNow hUntil
  simp [prune, h]

def pruneMany : List Int → Option Int → Option Int
  | [], seen => seen
  | now :: rest, seen => pruneMany rest (prune seen now)

theorem live_entry_survives_any_bounded_prunes (times : List Int)
    (retainTo validUntil : Int) (hUntil : validUntil ≤ retainTo)
    (hTimes : ∀ t ∈ times, t ≤ validUntil) :
    pruneMany times (some retainTo) = some retainTo := by
  induction times with
  | nil => rfl
  | cons t rest ih =>
      have hT : t ≤ validUntil := hTimes t (by simp)
      have hRest : ∀ n ∈ rest, n ≤ validUntil := by
        intro n hn
        exact hTimes n (by simp [hn])
      simp only [pruneMany]
      rw [prune_keeps_live_entry retainTo validUntil t hUntil hT]
      exact ih hRest

theorem duplicate_is_refused_while_retained (retainTo now ttl validUntil : Int)
    (capacity length otherCount : Nat) (hNow : now ≤ retainTo)
    (hLength : length > 0) (hLimit : length ≤ 256) :
    (record (some retainTo) now ttl validUntil capacity length otherCount).1 = .replay := by
  have hNotOver : ¬ 256 < length := Nat.not_lt.mpr hLimit
  simp [record, prune, hNow, hNotOver, Nat.ne_of_gt hLength]

theorem duplicate_refused_after_bounded_prunes
    (times : List Int) (now ttl validUntil initialTtlEnd : Int)
    (capacity length otherCount : Nat) (hTimes : ∀ t ∈ times, t ≤ validUntil)
    (hNow : now ≤ validUntil) (hLength : length > 0) (hLimit : length ≤ 256) :
    (record (pruneMany times (some (max initialTtlEnd validUntil)))
      now ttl validUntil capacity length otherCount).1 = .replay := by
  have hUntil : validUntil ≤ max initialTtlEnd validUntil := Int.le_max_right _ _
  rw [live_entry_survives_any_bounded_prunes times _ validUntil hUntil hTimes]
  exact duplicate_is_refused_while_retained _ now ttl validUntil capacity length otherCount
    (Int.le_trans hNow hUntil) hLength hLimit

theorem accepted_then_no_replay_during_window
    (times : List Int) (first now ttl validUntil : Int)
    (capacity length firstOthers laterOthers : Nat)
    (hFirst : (record none first ttl validUntil capacity length firstOthers).1 = .accepted)
    (hTimes : ∀ t ∈ times, t ≤ validUntil) (hNow : now ≤ validUntil)
    (hLength : length > 0) (hLimit : length ≤ 256) :
    (record (pruneMany times (record none first ttl validUntil capacity length firstOthers).2)
      now ttl validUntil capacity length laterOthers).1 = .replay := by
  obtain ⟨retainTo, hStored, hUntil⟩ :=
    accepted_first_remembers first ttl validUntil capacity length firstOthers hFirst
  rw [hStored, live_entry_survives_any_bounded_prunes times retainTo validUntil hUntil hTimes]
  exact duplicate_is_refused_while_retained retainTo now ttl validUntil capacity length laterOthers
    (Int.le_trans hNow hUntil) hLength hLimit

theorem empty_identifier_denied (seen : Option Int) (now ttl validUntil : Int)
    (capacity otherCount : Nat) :
    (record seen now ttl validUntil capacity 0 otherCount).1 = .invalid := rfl

theorem long_identifier_denied (seen : Option Int) (now ttl validUntil : Int)
    (capacity length otherCount : Nat) (hLength : 256 < length) :
    (record seen now ttl validUntil capacity length otherCount).1 = .invalid := by
  simp [record, hLength]

theorem full_cache_never_accepts_new (now ttl validUntil : Int)
    (capacity length otherCount : Nat) (hFull : capacity ≤ otherCount) :
    (record none now ttl validUntil capacity length otherCount).1 ≠ .accepted := by
  by_cases h : length == 0 || length > 256 <;> simp [record, prune, h, hFull]

/-! DPOP-R2: the decoder's age window lies inside the replay window. `ageAdmits` is
`proof_age_admits` (replay.rs), which `decode_dpop_proof` (jwk.rs) requires; `replayUntil` is
`proof_replay_until`, which `DpopValidator::validate` passes to the cache as `valid_until`. -/
def checkedSub (a b : Int) : Option Int :=
  if intMin ≤ a - b ∧ a - b ≤ intMax then some (a - b) else none

def ageAdmits (now iat maxAge : Int) : Bool :=
  match checkedSub now iat with
  | some age => decide (age ≤ maxAge)
  | none => false

def replayUntil (iat maxAge : Int) : Int := saturatingAdd iat maxAge

theorem fresh_proof_inside_replay_window (now iat maxAge : Int) (hNow : now ≤ intMax)
    (h : ageAdmits now iat maxAge = true) : now ≤ replayUntil iat maxAge := by
  unfold ageAdmits checkedSub at h
  split at h
  · rename_i age hSub
    split at hSub
    · cases hSub
      simp only [decide_eq_true_eq] at h
      simp only [replayUntil, saturatingAdd]
      omega
    · cases hSub
  · cases h

-- A replayed proof (same `jti` and `iat`) that the decoder would still admit is refused.
theorem fresh_replay_refused
    (times : List Int) (first now ttl iat maxAge : Int)
    (capacity length firstOthers laterOthers : Nat)
    (hFirst : (record none first ttl (replayUntil iat maxAge) capacity length firstOthers).1 =
      .accepted)
    (hTimes : ∀ t ∈ times, t ≤ replayUntil iat maxAge) (hNow : now ≤ intMax)
    (hFresh : ageAdmits now iat maxAge = true) (hLength : length > 0) (hLimit : length ≤ 256) :
    (record (pruneMany times
        (record none first ttl (replayUntil iat maxAge) capacity length firstOthers).2)
      now ttl (replayUntil iat maxAge) capacity length laterOthers).1 = .replay :=
  accepted_then_no_replay_during_window times first now ttl (replayUntil iat maxAge) capacity
    length firstOthers laterOthers hFirst hTimes
    (fresh_proof_inside_replay_window now iat maxAge hNow hFresh) hLength hLimit

private def kindCases : List (String × Nat) := [
  ("empty", 0), ("ascii1", 1), ("ascii256", 256), ("ascii257", 257),
  ("utf8_128", 256), ("utf8_129", 258)]
private def times : List Int := [0, 100, intMax - 1, intMin + 1]
private def ttls : List Int := [-1, 0, 1, 300]
private def validOffsets : List Int := [-1, 0, 1, 360]
private def replayOffsets : List Int := [0, 1, 360, 361]
private def capacities : List Nat := [0, 1, 2]
private def label : Decision → String
  | .accepted => "accepted"
  | .invalid => "invalid"
  | .replay => "replay"
  | .capacity => "capacity"

def main : IO Unit := do
  for (kind, length) in kindCases do
    for first in times do
      for ttl in ttls do
        for vOffset in validOffsets do
          for rOffset in replayOffsets do
            for capacity in capacities do
              for prefill in [false, true] do
                let validUntil := saturatingAdd first vOffset
                let second := saturatingAdd first rOffset
                let otherRetain := max (saturatingAdd first ttl) validUntil
                let otherExists := prefill && capacity > 0
                let othersFirst := if otherExists && first ≤ otherRetain then 1 else 0
                let othersSecond := if otherExists && second ≤ otherRetain then 1 else 0
                let (firstResult, state) := record none first ttl validUntil capacity length othersFirst
                let (secondResult, _) := record state second ttl validUntil capacity length othersSecond
                let prefillBit := if prefill then "1" else "0"
                IO.println s!"{kind}\t{first}\t{ttl}\t{vOffset}\t{rOffset}\t{capacity}\t{prefillBit}\t{label firstResult}\t{label secondResult}"
  let instants := [intMin, intMin + 1, -301, -1, 0, 1, 299, 300, 301, intMax - 300, intMax - 1, intMax]
  for now in instants do
    for iat in instants do
      for maxAge in [-1, 0, 1, 300, intMax] do
        let admits := if ageAdmits now iat maxAge then "1" else "0"
        IO.println s!"window\t{now}\t{iat}\t{maxAge}\t{admits}\t{replayUntil iat maxAge}"

end OpenSesame.DpopReplay

def main : IO Unit := OpenSesame.DpopReplay.main
