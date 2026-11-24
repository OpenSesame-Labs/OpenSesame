/- Independently maintained required theorem types. Review each change against the documented requirement. -/
open OpenSesame.Invocation

#require_theorem OpenSesame.Invocation.prior_requires_binding_receipt_and_policy :
    ∀ (mode : Mode) (stored : Stored) (receipt : Receipt) (allows : Bool)
    (_h : decide mode stored receipt allows = .prior),
    stored = .sameBinding ∧ receipt = .valid ∧ allows = true

#require_theorem OpenSesame.Invocation.reserved_key_never_executes :
    ∀ (mode : Mode) (stored : Stored) (receipt : Receipt) (allows : Bool)
    (_h : stored ≠ .none), decide mode stored receipt allows ≠ .executed

#require_theorem OpenSesame.Invocation.replay_never_starts_an_invocation :
    ∀ (stored : Stored) (receipt : Receipt) (allows : Bool),
    decide .replay stored receipt allows = .prior ∨
      ∃ reason, decide .replay stored receipt allows = .conflict reason

#require_theorem OpenSesame.Invocation.current_denial_withholds_prior :
    ∀ (mode : Mode) (stored : Stored) (receipt : Receipt),
    decide mode stored receipt false ≠ .prior
