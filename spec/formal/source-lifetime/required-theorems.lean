/- Independently recorded obligations for the source-lifetime model. -/
open OpenSesame.SourceLifetime

#require_theorem OpenSesame.SourceLifetime.claim_quarantines :
    ∀ (s : OpenSesame.SourceLifetime.State) (owner expected : Nat), s.fence = none → owner ∉ s.retired →
      s.generation = expected → (step s (.claim owner expected)).withdrawn = true
#require_theorem OpenSesame.SourceLifetime.stale_owner_or_epoch_cannot_change :
    ∀ (s : OpenSesame.SourceLifetime.State) (owner epoch deadline : Nat), owns s owner epoch = false →
      step s (.activate owner epoch deadline) = s ∧ step s (.tighten owner epoch deadline) = s ∧
      step s (.withdraw owner epoch) = s ∧ step s (.retire owner epoch) = s
#require_theorem OpenSesame.SourceLifetime.tightening_keeps_the_earlier_deadline :
    ∀ (s : OpenSesame.SourceLifetime.State) (f : Fence) (owner epoch old requested : Nat),
      s.fence = some f → owns s owner epoch = true → f.deadline = some old →
      (step s (.tighten owner epoch requested)).fence =
        some { f with deadline := some (min old requested) }
#require_theorem OpenSesame.SourceLifetime.withdrawn_is_not_usable :
    ∀ (s : OpenSesame.SourceLifetime.State) (now : Nat), s.withdrawn = true → usable s now = false
#require_theorem OpenSesame.SourceLifetime.reserved_is_not_usable :
    ∀ (s : OpenSesame.SourceLifetime.State) (f : Fence) (now : Nat), s.fence = some f →
      f.deadline = none → usable s now = false
#require_theorem OpenSesame.SourceLifetime.deadline_is_inclusive :
    ∀ (s : OpenSesame.SourceLifetime.State) (f : Fence) (deadline now : Nat), s.fence = some f →
      f.deadline = some deadline → deadline ≤ now → usable s now = false
#require_theorem OpenSesame.SourceLifetime.observed_expiry_stays_unusable :
    ∀ (s : OpenSesame.SourceLifetime.State) (f : Fence) (deadline now earlier : Nat), s.withdrawn = false →
      s.fence = some f → f.deadline = some deadline → deadline ≤ now →
      usable (observe s now) earlier = false
#require_theorem OpenSesame.SourceLifetime.ordinary_cannot_reset_fence :
    ∀ (s : OpenSesame.SourceLifetime.State) (same trust : Bool) (now : Nat),
      fenceIdentity (step s (.ordinary same trust now)).fence = fenceIdentity s.fence ∧
      (s.managed = true → trust = false → (step s (.ordinary same trust now)).generation = s.generation) ∧
      (s.managed = true → same = false → (step s (.ordinary same trust now)).generation = s.generation)
#require_theorem OpenSesame.SourceLifetime.latched_survives_nonactivation :
    ∀ (s : OpenSesame.SourceLifetime.State) (owner epoch deadline : Nat) (same trust : Bool) (now : Nat),
      latched s = true →
      latched (step s (.tighten owner epoch deadline)) = true ∧
      latched (step s (.withdraw owner epoch)) = true ∧
      latched (step s (.ordinary same trust now)) = true
#require_theorem OpenSesame.SourceLifetime.quarantine_blocks_ordinary :
    ∀ (s : OpenSesame.SourceLifetime.State) (same trust : Bool) (now : Nat), s.managed = true → s.withdrawn = true →
      step s (.ordinary same trust now) = s
#require_theorem OpenSesame.SourceLifetime.retired_owner_cannot_claim :
    ∀ (s : OpenSesame.SourceLifetime.State) (owner expected : Nat), owner ∈ s.retired →
      step s (.claim owner expected) = s
#require_theorem OpenSesame.SourceLifetime.only_activation_recovers :
    ∀ (s : OpenSesame.SourceLifetime.State) (action : Action), s.managed = true → s.withdrawn = true → isActivation action = false →
      (step s action).withdrawn = true
