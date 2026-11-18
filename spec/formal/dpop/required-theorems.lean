/- Independently maintained required theorem types. Review each change against the documented requirement. -/
open OpenSesame.DpopReplay

#require_theorem OpenSesame.DpopReplay.insertion_retains_until_valid_end :
    ∀ (now ttl validUntil : Int),
    validUntil ≤ max (saturatingAdd now ttl) validUntil

#require_theorem OpenSesame.DpopReplay.accepted_first_remembers :
    ∀ (now ttl validUntil : Int)
    (capacity length otherCount : Nat)
    (_h : (record none now ttl validUntil capacity length otherCount).1 = .accepted),
    ∃ retainTo, (record none now ttl validUntil capacity length otherCount).2 = some retainTo ∧
      validUntil ≤ retainTo

#require_theorem OpenSesame.DpopReplay.prune_keeps_live_entry :
    ∀ (retainTo validUntil now : Int)
    (_hUntil : validUntil ≤ retainTo) (_hNow : now ≤ validUntil),
    prune (some retainTo) now = some retainTo

#require_theorem OpenSesame.DpopReplay.live_entry_survives_any_bounded_prunes :
    ∀ (times : List Int)
    (retainTo validUntil : Int) (_hUntil : validUntil ≤ retainTo)
    (_hTimes : ∀ t ∈ times, t ≤ validUntil),
    pruneMany times (some retainTo) = some retainTo

#require_theorem OpenSesame.DpopReplay.duplicate_is_refused_while_retained :
    ∀ (retainTo now ttl validUntil : Int)
    (capacity length otherCount : Nat) (_hNow : now ≤ retainTo)
    (_hLength : length > 0) (_hLimit : length ≤ 256),
    (record (some retainTo) now ttl validUntil capacity length otherCount).1 = .replay

#require_theorem OpenSesame.DpopReplay.duplicate_refused_after_bounded_prunes :
    ∀ (times : List Int) (now ttl validUntil initialTtlEnd : Int)
    (capacity length otherCount : Nat) (_hTimes : ∀ t ∈ times, t ≤ validUntil)
    (_hNow : now ≤ validUntil) (_hLength : length > 0) (_hLimit : length ≤ 256),
    (record (pruneMany times (some (max initialTtlEnd validUntil)))
      now ttl validUntil capacity length otherCount).1 = .replay

#require_theorem OpenSesame.DpopReplay.accepted_then_no_replay_during_window :
    ∀ (times : List Int) (first now ttl validUntil : Int)
    (capacity length firstOthers laterOthers : Nat)
    (_hFirst : (record none first ttl validUntil capacity length firstOthers).1 = .accepted)
    (_hTimes : ∀ t ∈ times, t ≤ validUntil) (_hNow : now ≤ validUntil)
    (_hLength : length > 0) (_hLimit : length ≤ 256),
    (record (pruneMany times (record none first ttl validUntil capacity length firstOthers).2)
      now ttl validUntil capacity length laterOthers).1 = .replay

#require_theorem OpenSesame.DpopReplay.empty_identifier_denied :
    ∀ (seen : Option Int) (now ttl validUntil : Int)
    (capacity otherCount : Nat),
    (record seen now ttl validUntil capacity 0 otherCount).1 = .invalid

#require_theorem OpenSesame.DpopReplay.long_identifier_denied :
    ∀ (seen : Option Int) (now ttl validUntil : Int)
    (capacity length otherCount : Nat) (_hLength : 256 < length),
    (record seen now ttl validUntil capacity length otherCount).1 = .invalid

#require_theorem OpenSesame.DpopReplay.full_cache_never_accepts_new :
    ∀ (now ttl validUntil : Int)
    (capacity length otherCount : Nat) (_hFull : capacity ≤ otherCount),
    (record none now ttl validUntil capacity length otherCount).1 ≠ .accepted
