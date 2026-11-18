/- Independently maintained required theorem types. Review each change against the documented requirement. -/
open OpenSesame.Authority

#require_theorem OpenSesame.Authority.export_cannot_escalate :
    ∀ (parent child : Bool)
    (_valid : exportNarrows parent child = true) (_exported : child = true),
    parent = true

#require_theorem OpenSesame.Authority.no_export_gain_in_chain :
    ∀ {root leaf : Bool} (_chain : ExportChain root leaf)
    (_exported : leaf = true),
    root = true

#require_theorem OpenSesame.Authority.replacement_cannot_add_export :
    ∀ (parent current replacement : Bool)
    (_valid : replacementNarrows parent current replacement = true)
    (_exported : replacement = true),
    parent = true ∧ current = true

#require_theorem OpenSesame.Authority.stranger_cannot_delegate :
    issuerAllowed false false = false

#require_theorem OpenSesame.Authority.bound_scope_cannot_be_dropped :
    ∀ (value : Nat),
    bindingNarrows (some value) none = false

#require_theorem OpenSesame.Authority.bound_scope_cannot_move :
    ∀ (parent child : Nat) (_h : parent ≠ child),
    bindingNarrows (some parent) (some child) = false

#require_theorem OpenSesame.Authority.bound_key_cannot_be_dropped :
    ∀ (value : Nat) (sameHolder : Bool),
    proofKeyAllowed (some value) none sameHolder = false

#require_theorem OpenSesame.Authority.parent_key_cannot_transfer :
    ∀ (value : Nat),
    proofKeyAllowed (some value) (some value) false = false

#require_theorem OpenSesame.Authority.child_read_requires_parent :
    ∀ (pRead pWrite cRead cWrite : Bool)
    (_h : actionsAllowed pRead pWrite cRead cWrite = true) (_r : cRead = true),
    pRead = true

#require_theorem OpenSesame.Authority.child_write_requires_parent :
    ∀ (pRead pWrite cRead cWrite : Bool)
    (_h : actionsAllowed pRead pWrite cRead cWrite = true) (_w : cWrite = true),
    pWrite = true
