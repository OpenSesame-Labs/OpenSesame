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

private def bit (value : Bool) : String := if value then "1" else "0"
private def keys : List (String × Option Nat) := [("none", none), ("one", some 1), ("two", some 2)]
private def parentKeys : List (String × Option Nat) := [("none", none), ("one", some 1)]

def main : IO Unit := do
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

end OpenSesame.Authority

def main : IO Unit := OpenSesame.Authority.main
