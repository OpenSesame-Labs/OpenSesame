/- Independent theorem signatures: compare changes with the SPIFFE requirements. -/
open OpenSesame.SpiffePolicy

#require_theorem OpenSesame.SpiffePolicy.no_identity_withdraws :
    ∀ (phase : Phase), step phase (.failure (classify .noIdentity)) = .withdrawn
#require_theorem OpenSesame.SpiffePolicy.permission_denial_withdraws :
    ∀ (phase : Phase), step phase (.failure (classify .permissionDenied)) = .withdrawn
#require_theorem OpenSesame.SpiffePolicy.empty_snapshot_withdraws :
    ∀ (phase : Phase), step phase (.failure (classify .missingSvids)) = .withdrawn
#require_theorem OpenSesame.SpiffePolicy.empty_response_withdraws :
    ∀ (phase : Phase), step phase (.failure (classify .emptyResponse)) = .withdrawn
#require_theorem OpenSesame.SpiffePolicy.missing_bundle_withdraws :
    ∀ (phase : Phase), step phase (.failure (classify .missingBundle)) = .withdrawn
#require_theorem OpenSesame.SpiffePolicy.malformed_snapshot_withdraws :
    ∀ (phase : Phase), step phase (.failure (classify .malformedField)) = .withdrawn
#require_theorem OpenSesame.SpiffePolicy.invalid_field_withdraws :
    ∀ (phase : Phase), step phase (.failure (classify .invalidField)) = .withdrawn
#require_theorem OpenSesame.SpiffePolicy.transient_transport_is_outage : classify .transport = .outage
#require_theorem OpenSesame.SpiffePolicy.unauthenticated_withdraws :
    ∀ (phase : Phase), step phase (.failure (classify .unauthenticated)) = .withdrawn
#require_theorem OpenSesame.SpiffePolicy.outage_preserves_active :
    step .active (.failure (classify .transport)) = .active
#require_theorem OpenSesame.SpiffePolicy.rejected_preserved_trust_keeps_active :
    step .active (.rejected true) = .active
#require_theorem OpenSesame.SpiffePolicy.only_activation_recovers :
    ∀ (event : Event) (_h : event ≠ .activated), step .withdrawn event = .withdrawn
#require_theorem OpenSesame.SpiffePolicy.missing_anchor_withdraws :
    ∀ (previous incoming : Nat) (_oldHas : previous.testBit 0 = true)
      (_missing : incoming.testBit 0 = false),
      step .active (.rejected (trustPreserved previous incoming)) = .withdrawn
#require_theorem OpenSesame.SpiffePolicy.missing_second_anchor_withdraws :
    ∀ (previous incoming : Nat) (_oldHas : previous.testBit 1 = true)
      (_missing : incoming.testBit 1 = false),
      step .active (.rejected (trustPreserved previous incoming)) = .withdrawn
#require_theorem OpenSesame.SpiffePolicy.missing_third_anchor_withdraws :
    ∀ (previous incoming : Nat) (_oldHas : previous.testBit 2 = true)
      (_missing : incoming.testBit 2 = false),
      step .active (.rejected (trustPreserved previous incoming)) = .withdrawn
#require_theorem OpenSesame.SpiffePolicy.outage_bounded_by_certificate :
    ∀ (notAfter since maxStale : Nat), outageDeadline notAfter since maxStale ≤ notAfter
#require_theorem OpenSesame.SpiffePolicy.outage_bounded_by_freshness :
    ∀ (notAfter since maxStale : Nat), outageDeadline notAfter since maxStale ≤ since + maxStale
#require_theorem OpenSesame.SpiffePolicy.retry_cannot_extend_deadline :
    ∀ (notAfter previous since maxStale : Nat), retryDeadline notAfter previous since maxStale ≤ previous
#require_theorem OpenSesame.SpiffePolicy.retry_bounded_by_certificate :
    ∀ (notAfter previous since maxStale : Nat), retryDeadline notAfter previous since maxStale ≤ notAfter
#require_theorem OpenSesame.SpiffePolicy.retry_bounded_by_freshness :
    ∀ (notAfter previous since maxStale : Nat), retryDeadline notAfter previous since maxStale ≤ since + maxStale
#require_theorem OpenSesame.SpiffePolicy.effective_bounded_by_certificate :
    ∀ (notAfter retainUntil : Nat), effectiveDeadline notAfter retainUntil ≤ notAfter
#require_theorem OpenSesame.SpiffePolicy.effective_bounded_by_retention :
    ∀ (notAfter retainUntil : Nat), effectiveDeadline notAfter retainUntil ≤ retainUntil
#require_theorem OpenSesame.SpiffePolicy.expired_is_not_usable :
    ∀ (now deadline : Nat) (_h : deadline ≤ now), usableAt now deadline = false
#require_theorem OpenSesame.SpiffePolicy.status_expired_at_retention :
    ∀ (now notAfter retainUntil : Nat) (_h : retainUntil ≤ now),
      usableAt now (effectiveDeadline notAfter retainUntil) = false
#require_theorem OpenSesame.SpiffePolicy.status_expired_at_certificate :
    ∀ (now notAfter retainUntil : Nat) (_h : notAfter ≤ now),
      usableAt now (effectiveDeadline notAfter retainUntil) = false
