import Lean

set_option autoImplicit false

namespace OpenSesame.Authority

def exportNarrows (parent child : Bool) : Bool := !child || parent

theorem export_cannot_escalate (parent child : Bool)
    (valid : exportNarrows parent child = true) (exported : child = true) : parent = true := by
  cases parent <;> cases child <;> simp_all [exportNarrows]

inductive ExportChain : Bool → Bool → Prop where
  | root (value : Bool) : ExportChain value value
  | step {root parent child : Bool} :
      ExportChain root parent → exportNarrows parent child = true → ExportChain root child

theorem no_export_gain_in_chain {root leaf : Bool} (chain : ExportChain root leaf)
    (exported : leaf = true) : root = true := by
  induction chain with
  | root => exact exported
  | step previous edge inductionHypothesis =>
    exact inductionHypothesis (export_cannot_escalate _ _ edge exported)

def replacementNarrows (parent current replacement : Bool) : Bool :=
  exportNarrows parent replacement && exportNarrows current replacement

theorem replacement_cannot_add_export (parent current replacement : Bool)
    (valid : replacementNarrows parent current replacement = true)
    (exported : replacement = true) : parent = true ∧ current = true := by
  cases parent <;> cases current <;> cases replacement <;>
    simp_all [replacementNarrows, exportNarrows]

def issuerAllowed (isHolder isIssuer : Bool) : Bool := isHolder || isIssuer

theorem stranger_cannot_delegate : issuerAllowed false false = false := rfl

def bindingNarrows (parent child : Option Nat) : Bool :=
  match parent, child with
  | none, _ => true
  | some _, none => false
  | some p, some c => Nat.beq p c

theorem bound_scope_cannot_be_dropped (value : Nat) :
    bindingNarrows (some value) none = false := rfl

theorem bound_scope_cannot_move (parent child : Nat) (h : parent ≠ child) :
    bindingNarrows (some parent) (some child) = false := by
  change Nat.beq parent child = false
  cases same : (Nat.beq parent child) with
  | false => rfl
  | true => exact False.elim (h (Nat.eq_of_beq_eq_true same))

def proofKeyAllowed (parent child : Option Nat) (sameHolder : Bool) : Bool :=
  match parent, child with
  | none, _ => true
  | some _, none => false
  | some p, some c => !(Nat.beq p c) || sameHolder

theorem bound_key_cannot_be_dropped (value : Nat) (sameHolder : Bool) :
    proofKeyAllowed (some value) none sameHolder = false := rfl

theorem parent_key_cannot_transfer (value : Nat) :
    proofKeyAllowed (some value) (some value) false = false := by
  change (!(Nat.beq value value) || false) = false
  rw [Nat.beq_refl]
  rfl

def actionsAllowed (pRead pWrite cRead cWrite : Bool) : Bool :=
  (!cRead || pRead) && (!cWrite || pWrite)

theorem child_read_requires_parent (pRead pWrite cRead cWrite : Bool)
    (h : actionsAllowed pRead pWrite cRead cWrite = true) (r : cRead = true) : pRead = true := by
  cases pRead <;> cases pWrite <;> cases cRead <;> cases cWrite <;>
    simp_all [actionsAllowed]

theorem child_write_requires_parent (pRead pWrite cRead cWrite : Bool)
    (h : actionsAllowed pRead pWrite cRead cWrite = true) (w : cWrite = true) : pWrite = true := by
  cases pRead <;> cases pWrite <;> cases cRead <;> cases cWrite <;>
    simp_all [actionsAllowed]

/-! AUTH-D7: constraint dimensions. `constraintsNarrow` is `validate_constraint_attenuation`
(grant_attenuation.rs, also `validate_constraint_narrowing`); `limitsNarrow` adds the depth
checks of `validate_lineage_pointers` and the audience check of `Grant::validate_attenuation`. -/
inductive Assurance | pwd | password | mfa | phishingResistant | unknown
/-- `assurance_rank`; an unknown name has no rank and is refused on either side. -/
def Assurance.rank : Assurance → Option Nat
  | .pwd | .password => some 1 | .mfa => some 2 | .phishingResistant => some 3 | .unknown => none
/-- `GrantConstraints` (grant.rs) with the grant's depth; ids and names become numbers. -/
structure Limits where
  (audiences : List Nat) (notBefore : Option Int) (expiresAt : Int) (assurance : Option Assurance)
  (authAge : Option Nat) (networks : List Nat) (digest : Option Nat)
  (offline : Nat) -- `offline_rank`
  (budgets : List (Nat × Int)) (depth maxDepth : Nat)
/-- `interval_contains` (grant.rs): inclusive start, exclusive end. -/
def active (l : Limits) (now : Int) : Bool :=
  (match l.notBefore with | some n => decide (n ≤ now) | none => true) && decide (now < l.expiresAt)
def timeNarrows (p c : Limits) : Bool :=
  decide (c.expiresAt ≤ p.expiresAt) &&
    (match p.notBefore, c.notBefore with
     | some pn, some cn => decide (pn ≤ cn) | some _, none => false | none, _ => true) &&
    (match c.notBefore with | some n => decide (n < c.expiresAt) | none => true)
def assuranceNarrows : Option Assurance → Option Assurance → Bool
  | none, _ => true | some _, none => false
  | some a, some b => match a.rank, b.rank with | some r, some s => decide (r ≤ s) | _, _ => false
def ageNarrows : Option Nat → Option Nat → Bool
  | none, _ => true | some _, none => false | some p, some c => decide (c ≤ p)
/-- Networks and audiences: an empty parent list is unrestricted. -/
def listNarrows (p c : List Nat) : Bool := p.isEmpty || (!c.isEmpty && c.all (p.contains ·))
def digestNarrows : Option Nat → Option Nat → Bool
  | none, _ => true | some _, none => false | some p, some c => p == c
def budgetOf (m : List (Nat × Int)) (k : Nat) : Option Int := (m.find? (·.1 == k)).map (·.2)
/-- `validate_budget_attenuation` (grant_budgets.rs). -/
def budgetsNarrow (p c : List (Nat × Int)) : Bool :=
  p.all (fun e => decide (0 ≤ e.2) &&
    match budgetOf c e.1 with | some w => decide (0 ≤ w) && decide (w ≤ e.2) | none => false) &&
  c.all (fun e => decide (0 ≤ e.2) && (budgetOf p e.1).isSome)
def constraintsNarrow (p c : Limits) : Bool :=
  timeNarrows p c && assuranceNarrows p.assurance c.assurance && ageNarrows p.authAge c.authAge &&
    listNarrows p.networks c.networks && digestNarrows p.digest c.digest &&
    decide (c.offline ≤ p.offline) && budgetsNarrow p.budgets c.budgets
def depthNarrows (p c : Limits) : Bool :=
  c.depth == p.depth + 1 && decide (c.maxDepth ≤ p.maxDepth) && decide (c.depth ≤ p.maxDepth)
def limitsNarrow (p c : Limits) : Bool :=
  depthNarrows p c && listNarrows p.audiences c.audiences && constraintsNarrow p c
/-- The limit checks of `Grant::validate_replacement`. -/
def replacementLimits (p cur r : Limits) : Bool :=
  r.depth == cur.depth && limitsNarrow p r && r.audiences.all (cur.audiences.contains ·) &&
    decide (r.maxDepth ≤ cur.maxDepth) && constraintsNarrow cur r
theorem list_narrows_spec {p c : List Nat} (t : listNarrows p c = true) (ne : p ≠ []) :
    c ≠ [] ∧ ∀ n ∈ c, n ∈ p := by
  simp only [listNarrows, Bool.or_eq_true, Bool.and_eq_true, List.isEmpty_iff, Bool.not_eq_true',
    List.isEmpty_eq_false_iff, List.all_eq_true, List.contains_iff_mem] at t
  exact t.elim (fun e => absurd e ne) id
private theorem entry_of_budget {m : List (Nat × Int)} {k : Nat} {v : Int} (e : budgetOf m k = some v) :
    (k, v) ∈ m := by
  unfold budgetOf at e
  cases f : m.find? (·.1 == k) with
  | none => rw [f] at e; cases e
  | some x =>
    rw [f] at e; cases e
    have key : x.1 = k := by simpa only [beq_iff_eq] using List.find?_some f
    exact key ▸ List.mem_of_find?_eq_some f

section
variable {p c : Limits} (h : constraintsNarrow p c = true)
include h
private theorem parts : timeNarrows p c = true ∧ assuranceNarrows p.assurance c.assurance = true ∧
    ageNarrows p.authAge c.authAge = true ∧ listNarrows p.networks c.networks = true ∧
    digestNarrows p.digest c.digest = true ∧ c.offline ≤ p.offline ∧
    budgetsNarrow p.budgets c.budgets = true := by
  simp only [constraintsNarrow, Bool.and_eq_true, decide_eq_true_eq] at h
  obtain ⟨⟨⟨⟨⟨⟨a, b⟩, c⟩, d⟩, e⟩, f⟩, g⟩ := h
  exact ⟨a, b, c, d, e, f, g⟩
theorem window_cannot_widen (now : Int) (a : active c now = true) : active p now = true := by
  have t := (parts h).1
  simp only [timeNarrows, active, Bool.and_eq_true, decide_eq_true_eq] at t a ⊢
  obtain ⟨⟨exp, nbf⟩, _⟩ := t
  refine ⟨?_, Int.lt_of_lt_of_le a.2 exp⟩
  revert nbf a
  cases p.notBefore <;> cases c.notBefore <;> simp only [decide_eq_true_eq, Bool.false_eq_true,
    imp_self, implies_true, true_and, false_implies] <;> (intro x y; omega)
theorem assurance_cannot_weaken (a : Assurance) (ha : p.assurance = some a) :
    ∃ b r s, c.assurance = some b ∧ a.rank = some r ∧ b.rank = some s ∧ r ≤ s := by
  have t := (parts h).2.1
  rw [ha] at t; revert t
  cases c.assurance with
  | none => intro t; cases t
  | some b =>
    cases ra : a.rank <;> cases rb : b.rank <;> simp only [assuranceNarrows, ra, rb,
      Bool.false_eq_true, decide_eq_true_eq, false_implies]
    intro le; exact ⟨b, _, _, rfl, rfl, rb, le⟩
theorem auth_age_cannot_widen (m : Nat) (hm : p.authAge = some m) :
    ∃ k, c.authAge = some k ∧ k ≤ m := by
  have t := (parts h).2.2.1
  rw [hm] at t; revert t
  cases c.authAge <;> simp only [ageNarrows, Bool.false_eq_true, decide_eq_true_eq, false_implies]
  intro le; exact ⟨_, rfl, le⟩
theorem networks_cannot_widen (ne : p.networks ≠ []) :
    c.networks ≠ [] ∧ ∀ n ∈ c.networks, n ∈ p.networks := list_narrows_spec (parts h).2.2.2.1 ne
theorem parameter_rules_cannot_change (d : Nat) (hd : p.digest = some d) : c.digest = some d := by
  have t := (parts h).2.2.2.2.1
  rw [hd] at t; revert t
  cases c.digest <;> simp only [digestNarrows, Bool.false_eq_true, false_implies, beq_iff_eq]
  intro e; rw [e]
theorem offline_cannot_widen : c.offline ≤ p.offline := (parts h).2.2.2.2.2.1
theorem budget_meter_cannot_drop_or_rise (k : Nat) (v : Int) (hv : budgetOf p.budgets k = some v) :
    ∃ w, budgetOf c.budgets k = some w ∧ 0 ≤ w ∧ w ≤ v := by
  have t := (parts h).2.2.2.2.2.2
  simp only [budgetsNarrow, Bool.and_eq_true, List.all_eq_true] at t
  have entry := t.1 _ (entry_of_budget hv)
  simp only [decide_eq_true_eq] at entry; revert entry
  cases budgetOf c.budgets k <;> simp only [Bool.false_eq_true, and_false, false_implies,
    Bool.and_eq_true, decide_eq_true_eq]
  intro ⟨_, nonneg, le⟩; exact ⟨_, rfl, nonneg, le⟩
theorem budget_key_cannot_appear (k : Nat) (w : Int) (hw : budgetOf c.budgets k = some w) :
    (budgetOf p.budgets k).isSome = true ∧ 0 ≤ w := by
  have t := (parts h).2.2.2.2.2.2
  simp only [budgetsNarrow, Bool.and_eq_true, List.all_eq_true] at t
  have entry := t.2 _ (entry_of_budget hw)
  simp only [decide_eq_true_eq] at entry
  exact ⟨entry.2, entry.1⟩
end
theorem audiences_cannot_widen {p c : Limits} (h : limitsNarrow p c = true) (ne : p.audiences ≠ []) :
    c.audiences ≠ [] ∧ ∀ n ∈ c.audiences, n ∈ p.audiences := by
  simp only [limitsNarrow, Bool.and_eq_true] at h
  exact list_narrows_spec h.1.2 ne
theorem replacement_narrows_both {p cur r : Limits} (h : replacementLimits p cur r = true) :
    limitsNarrow p r = true ∧ constraintsNarrow cur r = true ∧ r.maxDepth ≤ cur.maxDepth := by
  simp only [replacementLimits, Bool.and_eq_true, decide_eq_true_eq] at h
  exact ⟨h.1.1.1.2, h.2, h.1.2⟩

inductive LimitChain : Limits → Limits → Nat → Prop where
  | root (l : Limits) : LimitChain l l 0
  | step {root p c : Limits} {n : Nat} :
      LimitChain root p n → limitsNarrow p c = true → LimitChain root c (n + 1)
theorem chain_window_within_root {root leaf : Limits} {n : Nat} (chain : LimitChain root leaf n)
    (now : Int) (a : active leaf now = true) : active root now = true := by
  induction chain with
  | root => exact a
  | step _ edge ih =>
    simp only [limitsNarrow, Bool.and_eq_true] at edge; exact ih (window_cannot_widen edge.2 now a)
theorem chain_depth_bounded {root leaf : Limits} {n : Nat} (chain : LimitChain root leaf n) :
    leaf.depth = root.depth + n ∧ leaf.maxDepth ≤ root.maxDepth ∧ (0 < n → leaf.depth ≤ root.maxDepth) := by
  induction chain with
  | root => exact ⟨rfl, Nat.le_refl _, fun h => absurd h (Nat.lt_irrefl _)⟩
  | step _ edge ih =>
    simp only [limitsNarrow, depthNarrows, Bool.and_eq_true, beq_iff_eq, decide_eq_true_eq] at edge
    obtain ⟨⟨⟨⟨d, m⟩, b⟩, _⟩, _⟩ := edge; obtain ⟨id, im, _⟩ := ih
    exact ⟨by omega, by omega, fun _ => by omega⟩

/-! AUTH-D8: resource selectors. `patternMatches` is `resource_pattern_matches` (grant.rs),
`selectorContains` is `resource_selector_contains` and `resourcesAttenuate` is
`resources_attenuate` (grant_attenuation.rs). Strings are character lists. -/
abbrev Sel := List Char
def isSep (s : Char) : Bool := s == '/' || s == ':'
def splitWild (p : Sel) : Option (Sel × Char) :=
  match p.reverse with
  | '*' :: s :: rest => if isSep s then some (rest.reverse, s) else none
  | _ => none
theorem splitWild_spec {p pre : Sel} {s : Char} (h : splitWild p = some (pre, s)) :
    p = pre ++ [s, '*'] := by
  have e : p = p.reverse.reverse := (List.reverse_reverse p).symm
  unfold splitWild at h; revert e h; generalize p.reverse = l; intro h e
  split at h
  next => split at h <;> cases h; simp [e]
  next => cases h
def patternMatches (p r : Sel) : Bool :=
  p == ['*'] || p == r ||
    match splitWild p with
    | some (pre, s) => (pre ++ [s]).isPrefixOf r && decide ((pre ++ [s]).length < r.length)
    | none => false
def isWildcard (c : Sel) : Bool := c == ['*'] || (splitWild c).isSome
def selectorContains (p c : Sel) : Bool :=
  p == ['*'] || p == c || (!isWildcard c && patternMatches p c) ||
    match splitWild p, splitWild c with
    | some (pp, s), some (cp, t) =>
        s == t && !pp.isEmpty && pp.isPrefixOf cp &&
          (cp.length == pp.length || cp[pp.length]? == some s)
    | _, _ => false
theorem subtree_prefix {pp cp : Sel} {s : Char} (pre : pp <+: cp)
    (bound : cp.length = pp.length ∨ cp[pp.length]? = some s) : pp ++ [s] <+: cp ++ [s] := by
  cases bound with
  | inl same => rw [pre.eq_of_length same.symm]; exact List.prefix_refl _
  | inr next =>
    obtain ⟨rest, hrest⟩ := pre; subst hrest
    rw [List.getElem?_append_right (Nat.le_refl _), Nat.sub_self] at next
    cases rest with
    | nil => simp only [List.length_nil, Nat.lt_irrefl, not_false_eq_true, getElem?_neg, reduceCtorEq] at next
    | cons x tail =>
      simp only [List.length_cons, Nat.zero_lt_succ, getElem?_pos, List.getElem_cons_zero,
        Option.some.injEq] at next; subst next
      exact ⟨tail ++ [x], by simp only [List.append_assoc, List.cons_append, List.nil_append]⟩
theorem matches_via_prefix {p r : Sel} {pre : Sel} {s : Char} (split : splitWild p = some (pre, s))
    (h : pre ++ [s] <+: r) (len : (pre ++ [s]).length < r.length) : patternMatches p r = true := by
  simp only [patternMatches, split, Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq]
  exact Or.inr ⟨(List.isPrefixOf_iff_prefix).2 h, len⟩
theorem selector_containment_sound (p c r : Sel) (h : selectorContains p c = true)
    (m : patternMatches c r = true) : patternMatches p r = true := by
  unfold selectorContains at h
  simp only [Bool.or_eq_true, Bool.and_eq_true, beq_iff_eq, Bool.not_eq_true'] at h
  rcases h with ((star | same) | ⟨notWild, pm⟩) | sub
  · subst star; rfl
  · subst same; exact m
  · have cnot : c ≠ ['*'] ∧ splitWild c = none := by
      unfold isWildcard at notWild
      simp only [Bool.or_eq_false_iff, beq_eq_false_iff_ne, Option.isSome_eq_false_iff,
        Option.isNone_iff_eq_none] at notWild
      exact notWild
    unfold patternMatches at m
    simp only [cnot.2, Bool.or_false, Bool.or_eq_true, beq_iff_eq] at m
    rcases m with bad | eq
    · exact absurd bad cnot.1
    · exact eq ▸ pm
  · split at sub
    next pp s cp t sp sc =>
      simp only [Bool.and_eq_true, beq_iff_eq, Bool.or_eq_true, Bool.not_eq_true',
        List.isEmpty_eq_false_iff] at sub
      obtain ⟨⟨⟨st, _⟩, pre⟩, bound⟩ := sub; subst st
      have pre' := (List.isPrefixOf_iff_prefix).1 pre
      have bound' : cp.length = pp.length ∨ cp[pp.length]? = some s := by
        rcases bound with b | b
        · exact Or.inl b
        · exact Or.inr (by simpa only using b)
      have key := subtree_prefix pre' bound'
      have plen := pre'.length_le
      have ceq := splitWild_spec sc; subst ceq
      unfold patternMatches at m
      simp only [Bool.or_eq_true, beq_iff_eq, sc, Bool.and_eq_true, decide_eq_true_eq] at m
      rcases m with (bad | eq) | ⟨cpre, clen⟩
      · have := congrArg List.length bad
        simp only [List.length_append, List.length_cons, List.length_nil] at this
        omega
      · subst eq
        apply matches_via_prefix sp (key.trans ⟨['*'], by simp only [List.append_assoc, List.cons_append, List.nil_append]⟩)
        simp only [List.length_append, List.length_cons, List.length_nil]; omega
      · apply matches_via_prefix sp (key.trans ((List.isPrefixOf_iff_prefix).1 cpre))
        simp only [List.length_append, List.length_cons, List.length_nil] at clen ⊢; omega
    next => simp only [Bool.false_eq_true] at sub
def resourcesAttenuate (child parent : List Sel) : Bool :=
  child.all (fun c => parent.any (fun p => selectorContains p c))
def permits (resources : List Sel) (r : Sel) : Bool := resources.any (fun p => patternMatches p r)
theorem resources_cannot_widen (child parent : List Sel) (h : resourcesAttenuate child parent = true)
    (r : Sel) (m : permits child r = true) : permits parent r = true := by
  obtain ⟨c, mem, cm⟩ := List.any_eq_true.1 m
  obtain ⟨p, pmem, contains⟩ := List.any_eq_true.1 (List.all_eq_true.1 h c mem)
  exact List.any_eq_true.2 ⟨p, pmem, selector_containment_sound p c r contains cm⟩

private def bit (value : Bool) : String := if value then "1" else "0"
private def keys : List (String × Option Nat) := [("none", none), ("one", some 1), ("two", some 2)]
private def parentKeys : List (String × Option Nat) := [("none", none), ("one", some 1)]

def coreMain : IO Unit := do
  for parent in [false, true] do
    for child in [false, true] do
      IO.println s!"delegate\t{bit parent}\t{bit child}\t{bit (exportNarrows parent child)}"
      for replacement in [false, true] do
        IO.println s!"replacement\t{bit parent}\t{bit child}\t{bit replacement}\t{bit (replacementNarrows parent child replacement)}"
  for holder in [false, true] do
    for issuer in [false, true] do
      IO.println s!"issuer\t{bit holder}\t{bit issuer}\t{bit (issuerAllowed holder issuer)}"
  for (parentLabel, parent) in parentKeys do
    for (childLabel, child) in keys do
      IO.println s!"scope\t{parentLabel}\t{childLabel}\t{bit (bindingNarrows parent child)}"
      for sameHolder in [false, true] do
        IO.println s!"key\t{parentLabel}\t{childLabel}\t{bit sameHolder}\t{bit (proofKeyAllowed parent child sameHolder)}"
  for pRead in [false, true] do
    for pWrite in [false, true] do
      for cRead in [false, true] do
        for cWrite in [false, true] do
          IO.println s!"actions\t{bit pRead}\t{bit pWrite}\t{bit cRead}\t{bit cWrite}\t{bit (actionsAllowed pRead pWrite cRead cWrite)}"

private def opt {α : Type} (f : α → String) : Option α → String | none => "none" | some a => f a
private def nums (l : List Nat) : String := if l.isEmpty then "-" else ",".intercalate (l.map toString)
private def assuranceName : Assurance → String
  | .pwd => "pwd" | .password => "password" | .mfa => "mfa"
  | .phishingResistant => "phishing-resistant" | .unknown => "fido"
private def limitsText (l : Limits) : String :=
  let budgets := if l.budgets.isEmpty then "-" else ",".intercalate (l.budgets.map fun e => s!"{e.1}={e.2}")
  "\t".intercalate [nums l.audiences, opt toString l.notBefore, toString l.expiresAt,
    opt assuranceName l.assurance, opt toString l.authAge, nums l.networks, opt toString l.digest,
    toString l.offline, budgets, toString l.depth, toString l.maxDepth]
private def wide : Limits := ⟨[], none, 30, none, none, [], none, 2, [(0, 10), (1, 10)], 0, 3⟩
private def lists : List (List Nat) := [[], [1], [2], [1, 2]]
private def meters : List (Option Int) := [none, some (-1), some 0, some 5, some 10]
private def budgetMaps : List (List (Nat × Int)) :=
  meters.flatMap fun a => meters.map fun b => (a.map (0, ·)).toList ++ (b.map (1, ·)).toList
private def dimension (name : String) (pairs : List (Limits × Limits)) : IO Unit :=
  for (p, c) in pairs do
    IO.println s!"attenuate\t{name}\t{limitsText p}\t{limitsText c}\t{bit (limitsNarrow p c)}"
    let cur := { p with depth := p.depth + 1 }; IO.println s!"replace\t{name}\t{limitsText wide}\t{limitsText cur}\t{limitsText c}\t{bit (replacementLimits wide cur c)}"
private def vary {α : Type} (values : List α) (set : Limits → α → Limits) : List (Limits × Limits) :=
  values.flatMap fun a => values.map fun b => (set { wide with offline := 0 } a, set { wide with offline := 0, depth := 1 } b)

def limitsMain : IO Unit := do
  let times := [none, some 0, some 10, some 20].flatMap fun n => [10, 20, 30].map fun e => (n, e)
  dimension "time" (vary times fun l (n, e) => { l with notBefore := n, expiresAt := e })
  dimension "audiences" (vary lists fun l v => { l with audiences := v })
  dimension "assurance" (vary [none, some .pwd, some .password, some .mfa, some .phishingResistant,
    some .unknown] fun l v => { l with assurance := v })
  dimension "auth_age" (vary [none, some 0, some 300, some 600] fun l v => { l with authAge := v })
  dimension "networks" (vary lists fun l v => { l with networks := v })
  dimension "digest" (vary [none, some 1, some 2] fun l v => { l with digest := v })
  dimension "offline" (vary [0, 1, 2] fun l v => { l with offline := v })
  dimension "budgets" (vary budgetMaps fun l v => { l with budgets := v })
  let depths := [0, 1, 2, 3].flatMap fun d => [0, 1, 2, 3].map fun m => (d, m)
  dimension "depth" (vary depths fun l (d, m) => { l with depth := d, maxDepth := m })
  let selectors := ["*", "a", "a/", "ab", "a/b", "a:b", "a/*", "ab/*", "a/b/*", "a/b:*", "a:*", "a:b/*",
    "a:b:*", "/*", ":*", "a*", "é/*", "é/x", "a/é"]
  for p in selectors do
    for c in selectors do
      IO.println s!"selector\t{p}\t{c}\t{bit (selectorContains p.toList c.toList)}"
      IO.println s!"pattern\t{p}\t{c}\t{bit (patternMatches p.toList c.toList)}"

end OpenSesame.Authority

def main : IO Unit := do
  OpenSesame.Authority.coreMain
  OpenSesame.Authority.limitsMain
