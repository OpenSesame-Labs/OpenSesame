import Lean

set_option autoImplicit false

/-! INV-I1: a retry returns a prior receipt only for the same effect and
authority, after the current policy decision, and never runs a second effect.

The model follows `Broker::invoke_inner` (crates/broker/src/lib.rs): the
parameter digest and `legacy_fingerprint` are computed, the current policy is
decided, then `prior_receipt` (crates/broker/src/idempotency.rs) looks the
idempotency key up. A stored row without a fingerprint, or with a different
one, is a conflict; a matching row needs a stored receipt that is opaque,
verifies under the current signer, commits to the stored intent digest and
carries the matching idempotency commitment; only then, and only if the
current decision allows, is it returned. With no stored row a replay fails
and an invocation runs (or records a denial). Storage reads are taken as
given; concurrency between them is outside the model. -/

namespace OpenSesame.Invocation

inductive Mode where
  | invoke | replay
  deriving DecidableEq, Repr

/-- What `find_idempotent_intent` returns for the request's key. -/
inductive Stored where
  | none | unbound | otherBinding | sameBinding
  deriving DecidableEq, Repr

/-- The receipt stored under the key, if any, and the first check it fails. -/
inductive Receipt where
  | none | valid | badSignature | otherIntent | otherBinding | notOpaque
  deriving DecidableEq, Repr

/-- Why `invoke_inner` refuses, as its error names it. -/
inductive Conflict where
  | binding | noReceipt | unsafeReceipt | denied | noPrior
  deriving DecidableEq, Repr

inductive Outcome where
  | executed | denied | prior
  | conflict (reason : Conflict)
  deriving DecidableEq, Repr

def decide (mode : Mode) (stored : Stored) (receipt : Receipt) (allows : Bool) : Outcome :=
  match stored with
  | .none =>
    match mode with
    | .replay => .conflict .noPrior
    | .invoke => if allows then .executed else .denied
  | .unbound | .otherBinding => .conflict .binding
  | .sameBinding =>
    match receipt with
    | .none => .conflict .noReceipt
    | .valid => if allows then .prior else .conflict .denied
    | _ => .conflict .unsafeReceipt

theorem prior_requires_binding_receipt_and_policy (mode : Mode) (stored : Stored)
    (receipt : Receipt) (allows : Bool) (h : decide mode stored receipt allows = .prior) :
    stored = .sameBinding ∧ receipt = .valid ∧ allows = true := by
  cases mode <;> cases stored <;> cases receipt <;> cases allows <;> simp_all [decide]

theorem reserved_key_never_executes (mode : Mode) (stored : Stored) (receipt : Receipt)
    (allows : Bool) (h : stored ≠ .none) : decide mode stored receipt allows ≠ .executed := by
  cases mode <;> cases stored <;> cases receipt <;> cases allows <;> simp_all [decide]

theorem replay_never_starts_an_invocation (stored : Stored) (receipt : Receipt) (allows : Bool) :
    decide .replay stored receipt allows = .prior ∨
      ∃ reason, decide .replay stored receipt allows = .conflict reason := by
  cases stored <;> cases receipt <;> cases allows <;> simp [decide]

theorem current_denial_withholds_prior (mode : Mode) (stored : Stored) (receipt : Receipt) :
    decide mode stored receipt false ≠ .prior := by
  cases mode <;> cases stored <;> cases receipt <;> simp [decide]

private def modeName : Mode → String | .invoke => "invoke" | .replay => "replay"
private def storedName : Stored → String
  | .none => "none" | .unbound => "unbound" | .otherBinding => "other-binding"
  | .sameBinding => "same-binding"
private def receiptName : Receipt → String
  | .none => "none" | .valid => "valid" | .badSignature => "bad-signature"
  | .otherIntent => "other-intent" | .otherBinding => "other-binding" | .notOpaque => "not-opaque"
private def outcomeName : Outcome → String
  | .executed => "executed" | .denied => "denied" | .prior => "prior"
  | .conflict .binding => "conflict:binding" | .conflict .noReceipt => "conflict:no-receipt"
  | .conflict .unsafeReceipt => "conflict:unsafe-receipt" | .conflict .denied => "conflict:denied"
  | .conflict .noPrior => "conflict:no-prior"

def main : IO Unit := do
  for mode in [Mode.invoke, .replay] do
    for stored in [Stored.none, .unbound, .otherBinding, .sameBinding] do
      let receipts := if stored == .sameBinding then
        [Receipt.none, .valid, .badSignature, .otherIntent, .otherBinding, .notOpaque] else [.none]
      for receipt in receipts do
        for allows in [true, false] do
          IO.println s!"{modeName mode}\t{storedName stored}\t{receiptName receipt}\t{if allows then 1 else 0}\t{outcomeName (decide mode stored receipt allows)}"

end OpenSesame.Invocation
