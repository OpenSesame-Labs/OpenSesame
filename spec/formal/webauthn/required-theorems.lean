/- Independently maintained required theorem types. Review each change against the documented requirement. -/
open OpenSesame.ApprovalBinding

#require_theorem OpenSesame.ApprovalBinding.invalid_clock_denied :
    ∀ (kind : Kind) (status : Status) (validExpiry : Bool) (expiresAt now : Int)
    (requestDigest : Option String) (proofDigest : String),
    approvalWithClock false kind status validExpiry expiresAt now requestDigest proofDigest = false

#require_theorem OpenSesame.ApprovalBinding.approved_requires_valid_clock :
    ∀ (clockValid : Bool) (kind : Kind) (status : Status) (validExpiry : Bool)
    (expiresAt now : Int) (requestDigest : Option String) (proofDigest : String)
    (_h : approvalWithClock clockValid kind status validExpiry expiresAt now requestDigest proofDigest = true),
    clockValid = true

#require_theorem OpenSesame.ApprovalBinding.valid_clock_preserves_policy :
    ∀ (kind : Kind) (status : Status) (validExpiry : Bool) (expiresAt now : Int)
    (requestDigest : Option String) (proofDigest : String),
    approvalWithClock true kind status validExpiry expiresAt now requestDigest proofDigest =
      approvalAllowed kind status validExpiry expiresAt now requestDigest proofDigest

#require_theorem OpenSesame.ApprovalBinding.approved_proof_matches_request :
    ∀ (kind : Kind) (status : Status)
    (validExpiry : Bool) (expiresAt now : Int) (requestDigest proofDigest : String)
    (_h : approvalAllowed kind status validExpiry expiresAt now (some requestDigest) proofDigest = true),
    proofDigest = requestDigest

#require_theorem OpenSesame.ApprovalBinding.operation_needs_digest :
    ∀ (kind : Kind) (status : Status) (validExpiry : Bool)
    (expiresAt now : Int) (proofDigest : String) (_required : requiresDigest kind = true),
    approvalAllowed kind status validExpiry expiresAt now none proofDigest = false

#require_theorem OpenSesame.ApprovalBinding.operation_denies_empty_digest :
    ∀ (kind : Kind) (status : Status) (validExpiry : Bool)
    (expiresAt now : Int) (proofDigest : String) (_required : requiresDigest kind = true),
    approvalAllowed kind status validExpiry expiresAt now (some "") proofDigest = false

#require_theorem OpenSesame.ApprovalBinding.approved_operation_has_nonempty_digest :
    ∀ (kind : Kind) (status : Status)
    (validExpiry : Bool) (expiresAt now : Int) (requestDigest : Option String)
    (proofDigest : String) (_required : requiresDigest kind = true)
    (_h : approvalAllowed kind status validExpiry expiresAt now requestDigest proofDigest = true),
    ∃ digest, requestDigest = some digest ∧ digest ≠ ""

#require_theorem OpenSesame.ApprovalBinding.absent_digest_rejects_nonempty_proof :
    ∀ (kind : Kind) (status : Status)
    (validExpiry : Bool) (expiresAt now : Int) (proofDigest : String)
    (_nonempty : proofDigest ≠ ""),
    approvalAllowed kind status validExpiry expiresAt now none proofDigest = false

#require_theorem OpenSesame.ApprovalBinding.approval_requires_awaiting :
    ∀ (kind : Kind) (status : Status) (validExpiry : Bool)
    (expiresAt now : Int) (requestDigest : Option String) (proofDigest : String)
    (_h : approvalAllowed kind status validExpiry expiresAt now requestDigest proofDigest = true),
    status = .awaitingApproval

#require_theorem OpenSesame.ApprovalBinding.approval_denied_at_or_after_expiry :
    ∀ (kind : Kind) (status : Status)
    (validExpiry : Bool) (expiresAt now : Int) (requestDigest : Option String)
    (proofDigest : String) (_expired : expiresAt ≤ now),
    approvalAllowed kind status validExpiry expiresAt now requestDigest proofDigest = false

#require_theorem OpenSesame.ApprovalBinding.invalid_expiry_denied :
    ∀ (kind : Kind) (status : Status) (expiresAt now : Int)
    (requestDigest : Option String) (proofDigest : String),
    approvalAllowed kind status false expiresAt now requestDigest proofDigest = false

#require_theorem OpenSesame.ApprovalBinding.consumed_cannot_consume_again :
    ∀ (live : Bool),
    consume .consumed live = none
