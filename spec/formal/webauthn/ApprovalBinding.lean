import Lean

set_option autoImplicit false

namespace OpenSesame.ApprovalBinding

inductive Kind where
  | deviceAuthorization | pairing | claim | grantClaim
  | authorizationRequest | transactionAuthorization
  deriving BEq, DecidableEq, Repr

inductive Status where
  | pending | presented | awaitingApproval | approved
  | denied | consumed | expired | revoked
  deriving BEq, DecidableEq, Repr

def requiresDigest : Kind → Bool
  | .grantClaim | .authorizationRequest | .transactionAuthorization => true
  | _ => false

def digestAllowed (kind : Kind) (requestDigest : Option String) (proofDigest : String) : Bool :=
  match requestDigest with
  | some digest => (!(requiresDigest kind) || digest != "") && (proofDigest == digest)
  | none => !(requiresDigest kind) && (proofDigest == "")

def approvalAllowed (kind : Kind) (status : Status) (validExpiry : Bool)
    (expiresAt now : Int) (requestDigest : Option String) (proofDigest : String) : Bool :=
  digestAllowed kind requestDigest proofDigest && decide (status = .awaitingApproval) &&
    validExpiry && decide (now < expiresAt)

/-- A non-finite current clock is never a valid approval time. -/
def approvalWithClock (clockValid : Bool) (kind : Kind) (status : Status)
    (validExpiry : Bool) (expiresAt now : Int)
    (requestDigest : Option String) (proofDigest : String) : Bool :=
  clockValid && approvalAllowed kind status validExpiry expiresAt now requestDigest proofDigest

theorem invalid_clock_denied (kind : Kind) (status : Status)
    (validExpiry : Bool) (expiresAt now : Int)
    (requestDigest : Option String) (proofDigest : String) :
    approvalWithClock false kind status validExpiry expiresAt now requestDigest proofDigest = false := by
  simp [approvalWithClock]

theorem approved_requires_valid_clock (clockValid : Bool) (kind : Kind) (status : Status)
    (validExpiry : Bool) (expiresAt now : Int) (requestDigest : Option String)
    (proofDigest : String)
    (h : approvalWithClock clockValid kind status validExpiry expiresAt now requestDigest proofDigest = true) :
    clockValid = true := by
  simp only [approvalWithClock, Bool.and_eq_true] at h
  exact h.1

theorem valid_clock_preserves_policy (kind : Kind) (status : Status)
    (validExpiry : Bool) (expiresAt now : Int)
    (requestDigest : Option String) (proofDigest : String) :
    approvalWithClock true kind status validExpiry expiresAt now requestDigest proofDigest =
      approvalAllowed kind status validExpiry expiresAt now requestDigest proofDigest := by
  simp [approvalWithClock]

theorem approved_proof_matches_request (kind : Kind) (status : Status)
    (validExpiry : Bool) (expiresAt now : Int) (requestDigest proofDigest : String)
    (h : approvalAllowed kind status validExpiry expiresAt now (some requestDigest) proofDigest = true) :
    proofDigest = requestDigest := by
  simp [approvalAllowed, digestAllowed] at h
  exact h.1.1.1.2

theorem operation_needs_digest (kind : Kind) (status : Status) (validExpiry : Bool)
    (expiresAt now : Int) (proofDigest : String) (required : requiresDigest kind = true) :
    approvalAllowed kind status validExpiry expiresAt now none proofDigest = false := by
  simp [approvalAllowed, digestAllowed, required]

theorem operation_denies_empty_digest (kind : Kind) (status : Status) (validExpiry : Bool)
    (expiresAt now : Int) (proofDigest : String) (required : requiresDigest kind = true) :
    approvalAllowed kind status validExpiry expiresAt now (some "") proofDigest = false := by
  simp [approvalAllowed, digestAllowed, required]

theorem approved_operation_has_nonempty_digest (kind : Kind) (status : Status)
    (validExpiry : Bool) (expiresAt now : Int) (requestDigest : Option String)
    (proofDigest : String) (required : requiresDigest kind = true)
    (h : approvalAllowed kind status validExpiry expiresAt now requestDigest proofDigest = true) :
    ∃ digest, requestDigest = some digest ∧ digest ≠ "" := by
  cases requestDigest with
  | none => simp [approvalAllowed, digestAllowed, required] at h
  | some digest =>
    refine ⟨digest, rfl, ?_⟩
    intro empty
    subst digest
    simp [approvalAllowed, digestAllowed, required] at h

theorem absent_digest_rejects_nonempty_proof (kind : Kind) (status : Status)
    (validExpiry : Bool) (expiresAt now : Int) (proofDigest : String)
    (nonempty : proofDigest ≠ "") :
    approvalAllowed kind status validExpiry expiresAt now none proofDigest = false := by
  simp [approvalAllowed, digestAllowed, nonempty]

theorem approval_requires_awaiting (kind : Kind) (status : Status) (validExpiry : Bool)
    (expiresAt now : Int) (requestDigest : Option String) (proofDigest : String)
    (h : approvalAllowed kind status validExpiry expiresAt now requestDigest proofDigest = true) :
    status = .awaitingApproval := by
  simp [approvalAllowed] at h
  exact h.1.1.2

theorem approval_denied_at_or_after_expiry (kind : Kind) (status : Status)
    (validExpiry : Bool) (expiresAt now : Int) (requestDigest : Option String)
    (proofDigest : String) (expired : expiresAt ≤ now) :
    approvalAllowed kind status validExpiry expiresAt now requestDigest proofDigest = false := by
  simp [approvalAllowed, Int.not_lt.mpr expired]

theorem invalid_expiry_denied (kind : Kind) (status : Status) (expiresAt now : Int)
    (requestDigest : Option String) (proofDigest : String) :
    approvalAllowed kind status false expiresAt now requestDigest proofDigest = false := by
  simp [approvalAllowed]

def consume (status : Status) (live : Bool) : Option Status :=
  if decide (status = .approved) && live then some .consumed else none

theorem consumed_cannot_consume_again (live : Bool) : consume .consumed live = none := by
  simp [consume]

private def kindCases : List (String × Kind) := [
  ("device_authorization", .deviceAuthorization), ("pairing", .pairing),
  ("claim", .claim), ("grant_claim", .grantClaim),
  ("authorization_request", .authorizationRequest),
  ("transaction_authorization", .transactionAuthorization)]

private def statusCases : List (String × Status) := [
  ("pending", .pending), ("presented", .presented),
  ("awaiting_approval", .awaitingApproval), ("approved", .approved),
  ("denied", .denied), ("consumed", .consumed),
  ("expired", .expired), ("revoked", .revoked)]

private def clockCases : List (String × Bool) := [
  ("invalid", false), ("valid", true)]

private def expiryCases : List (String × Bool × Int) := [
  ("invalid", false, 0), ("past", true, -1),
  ("equal", true, 0), ("future", true, 1)]

private def requestCases : List (String × Option String) := [
  ("absent", none), ("empty", some ""),
  ("a", some "sha256:a"), ("b", some "sha256:b")]

private def proofCases : List (String × String) := [
  ("empty", ""), ("a", "sha256:a"), ("b", "sha256:b"), ("other", "sha256:other")]

private def bit (b : Bool) : String := if b then "1" else "0"

def main : IO Unit := do
  for (kindName, kind) in kindCases do
    for (statusName, status) in statusCases do
      for (clockName, clockValid) in clockCases do
        for (expiryName, valid, expiry) in expiryCases do
          for (requestName, request) in requestCases do
            for (proofName, proof) in proofCases do
              let allowed := approvalWithClock clockValid kind status valid expiry 0 request proof
              IO.println s!"approval\t{kindName}\t{statusName}\t{clockName}\t{expiryName}\t{requestName}\t{proofName}\t{bit allowed}"

end OpenSesame.ApprovalBinding

def main : IO Unit := OpenSesame.ApprovalBinding.main
