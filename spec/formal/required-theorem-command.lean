/-
Each suite records its required theorem names and expected proposition types
in a separate obligations file. Elaborate each expected proposition and use
Lean's definitional equality to compare it with the actual theorem's full type.
Aliases, definitions, and axioms cannot replace a required theorem, and a
requirement cannot contain unresolved expression or universe metavariables.
The obligations may refer to model definitions; they do not prove refinement of
an implementation or freeze the meaning of those definitions.
-/
open Lean Elab Command

syntax (name := requireTheorem) "#require_theorem " ident " : " term : command
elab_rules : command
  | `(#require_theorem $name:ident : $expected:term) => do
    let id := name.getId
    -- The elaborator and kernel environments can differ after async errors.
    -- Inspect the declaration that the kernel actually checked.
    let info ← match (← getEnv).checked.get.find? id with
      | some (.thmInfo info) => pure info
      | _ => throwError "required theorem missing or not a theorem: {id}"
    let compatible ← liftTermElabM do
      let ty ← Lean.Elab.Term.elabType expected
      Lean.Elab.Term.synthesizeSyntheticMVarsNoPostponing
      let ty ← instantiateMVars ty
      if ty.hasMVar then throwError "unresolved metavariables in requirement: {id}"
      Lean.Meta.isDefEq info.type ty
    unless compatible do throwError "required theorem type mismatch: {id}"
    -- The marker makes duplicate entries an error and lets the caller check
    -- the expected number of independently recorded obligations.
    let marker := mkIdent (Name.mkStr `OpenSesame.CheckedObligations id.toString)
    elabCommand (← `(theorem $marker : True := True.intro))

syntax (name := requireTheoremCount) "#require_theorem_count " num : command
elab_rules : command
  | `(#require_theorem_count $expected:num) => do
    let env ← getEnv
    let count := (env.constants.map₂.toList.filter fun (name, _) =>
      (`OpenSesame.CheckedObligations).isPrefixOf name).length
    unless count == expected.getNat do
      throwError "expected {expected.getNat} required theorems, checked {count}"
