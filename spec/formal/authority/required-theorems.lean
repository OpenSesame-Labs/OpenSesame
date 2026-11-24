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

#require_theorem OpenSesame.Authority.window_cannot_widen :
    ∀ {p c : Limits} (_h : constraintsNarrow p c = true) (now : Int)
    (_a : active c now = true), active p now = true

#require_theorem OpenSesame.Authority.assurance_cannot_weaken :
    ∀ {p c : Limits} (_h : constraintsNarrow p c = true) (a : Assurance)
    (_ha : p.assurance = some a),
    ∃ b r s, c.assurance = some b ∧ a.rank = some r ∧ b.rank = some s ∧ r ≤ s

#require_theorem OpenSesame.Authority.auth_age_cannot_widen :
    ∀ {p c : Limits} (_h : constraintsNarrow p c = true) (m : Nat)
    (_hm : p.authAge = some m), ∃ k, c.authAge = some k ∧ k ≤ m

#require_theorem OpenSesame.Authority.networks_cannot_widen :
    ∀ {p c : Limits} (_h : constraintsNarrow p c = true) (_ne : p.networks ≠ []),
    c.networks ≠ [] ∧ ∀ n ∈ c.networks, n ∈ p.networks

#require_theorem OpenSesame.Authority.parameter_rules_cannot_change :
    ∀ {p c : Limits} (_h : constraintsNarrow p c = true) (d : Nat)
    (_hd : p.digest = some d), c.digest = some d

#require_theorem OpenSesame.Authority.offline_cannot_widen :
    ∀ {p c : Limits} (_h : constraintsNarrow p c = true), c.offline ≤ p.offline

#require_theorem OpenSesame.Authority.budget_meter_cannot_drop_or_rise :
    ∀ {p c : Limits} (_h : constraintsNarrow p c = true) (k : Nat) (v : Int)
    (_hv : budgetOf p.budgets k = some v),
    ∃ w, budgetOf c.budgets k = some w ∧ 0 ≤ w ∧ w ≤ v

#require_theorem OpenSesame.Authority.budget_key_cannot_appear :
    ∀ {p c : Limits} (_h : constraintsNarrow p c = true) (k : Nat) (w : Int)
    (_hw : budgetOf c.budgets k = some w),
    (budgetOf p.budgets k).isSome = true ∧ 0 ≤ w

#require_theorem OpenSesame.Authority.audiences_cannot_widen :
    ∀ {p c : Limits} (_h : limitsNarrow p c = true) (_ne : p.audiences ≠ []),
    c.audiences ≠ [] ∧ ∀ n ∈ c.audiences, n ∈ p.audiences

#require_theorem OpenSesame.Authority.replacement_narrows_both :
    ∀ {p cur r : Limits} (_h : replacementLimits p cur r = true),
    limitsNarrow p r = true ∧ constraintsNarrow cur r = true ∧ r.maxDepth ≤ cur.maxDepth

#require_theorem OpenSesame.Authority.chain_window_within_root :
    ∀ {root leaf : Limits} {n : Nat} (_chain : LimitChain root leaf n) (now : Int)
    (_a : active leaf now = true), active root now = true

#require_theorem OpenSesame.Authority.chain_depth_bounded :
    ∀ {root leaf : Limits} {n : Nat} (_chain : LimitChain root leaf n),
    leaf.depth = root.depth + n ∧ leaf.maxDepth ≤ root.maxDepth ∧
      (0 < n → leaf.depth ≤ root.maxDepth)

#require_theorem OpenSesame.Authority.selector_containment_sound :
    ∀ (p c r : Sel) (_h : selectorContains p c = true) (_m : patternMatches c r = true),
    patternMatches p r = true

#require_theorem OpenSesame.Authority.resources_cannot_widen :
    ∀ (child parent : List Sel) (_h : resourcesAttenuate child parent = true) (r : Sel)
    (_m : permits child r = true), permits parent r = true
