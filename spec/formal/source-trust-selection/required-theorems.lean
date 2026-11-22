/- Independent contract for the source-only Host listener selector. -/
open OpenSesame.SourceTrustSelection

#require_theorem OpenSesame.SourceTrustSelection.stale_view_is_refused :
  ∀ (present spiffeKind matchingProfile matchingDomain : Bool), choose false present spiffeKind matchingProfile matchingDomain = false
#require_theorem OpenSesame.SourceTrustSelection.missing_source_is_refused :
  ∀ (fresh spiffeKind matchingProfile matchingDomain : Bool), choose fresh false spiffeKind matchingProfile matchingDomain = false
#require_theorem OpenSesame.SourceTrustSelection.wrong_kind_is_refused :
  ∀ (fresh present matchingProfile matchingDomain : Bool), choose fresh present false matchingProfile matchingDomain = false
#require_theorem OpenSesame.SourceTrustSelection.wrong_profile_is_refused :
  ∀ (fresh present spiffeKind matchingDomain : Bool), choose fresh present spiffeKind false matchingDomain = false
#require_theorem OpenSesame.SourceTrustSelection.wrong_domain_is_refused :
  ∀ (fresh present spiffeKind matchingProfile : Bool), choose fresh present spiffeKind matchingProfile false = false
#require_theorem OpenSesame.SourceTrustSelection.selection_requires_all :
  ∀ (fresh present spiffeKind matchingProfile matchingDomain : Bool),
    choose fresh present spiffeKind matchingProfile matchingDomain = true ↔
      fresh = true ∧ present = true ∧ spiffeKind = true ∧ matchingProfile = true ∧ matchingDomain = true
#require_theorem OpenSesame.SourceTrustSelection.complete_source_is_accepted :
  choose true true true true true = true

#require_theorem OpenSesame.SourceTrustSelection.failed_rotation_keeps_state :
  ∀ (old : RotationSnapshot) (session view : Nat) (offered : Option Nat),
    rotateSnapshot old session view offered false = old
#require_theorem OpenSesame.SourceTrustSelection.explicit_material_is_committed :
  ∀ (old : RotationSnapshot) (session view material : Nat),
    (rotateSnapshot old session view (some material) true).material = material
#require_theorem OpenSesame.SourceTrustSelection.implicit_material_is_retained :
  ∀ (old : RotationSnapshot) (session view : Nat),
    (rotateSnapshot old session view none true).material = old.material
#require_theorem OpenSesame.SourceTrustSelection.successful_rotation_publishes_session_and_view :
  ∀ (old : RotationSnapshot) (session view : Nat) (offered : Option Nat),
    (rotateSnapshot old session view offered true).session = session ∧
    (rotateSnapshot old session view offered true).view = view
#require_theorem OpenSesame.SourceTrustSelection.implicit_after_explicit_reuses_material :
  ∀ (old : RotationSnapshot) (firstSession firstView secondSession secondView material : Nat),
    (rotateSnapshot (rotateSnapshot old firstSession firstView (some material) true)
      secondSession secondView none true).material = material
#require_theorem OpenSesame.SourceTrustSelection.later_serialized_success_controls_view :
  ∀ (old : RotationSnapshot) (firstSession firstView secondSession secondView : Nat)
    (firstMaterial secondMaterial : Option Nat) (firstSucceeded : Bool),
    (rotateSnapshot (rotateSnapshot old firstSession firstView firstMaterial firstSucceeded)
      secondSession secondView secondMaterial true).view = secondView
#require_theorem OpenSesame.SourceTrustSelection.fresh_handshake_gate_admits :
  handshakeAllowed false = true
#require_theorem OpenSesame.SourceTrustSelection.spent_handshake_gate_refuses :
  handshakeAllowed true = false
#require_theorem OpenSesame.SourceTrustSelection.consumed_handshake_gate_refuses :
  ∀ (spent : Bool), handshakeAllowed (consumeHandshake spent) = false
#require_theorem OpenSesame.SourceTrustSelection.injected_reconnect_is_capped :
  ∀ (requested : Option Nat), reconnectLimit true requested = some 1
#require_theorem OpenSesame.SourceTrustSelection.ordinary_reconnect_limit_is_preserved :
  ∀ (requested : Option Nat), reconnectLimit false requested = requested
#require_theorem OpenSesame.SourceTrustSelection.unrequested_identity_is_refused :
  identityAllowed false true = false
#require_theorem OpenSesame.SourceTrustSelection.wrong_client_id_is_refused :
  ∀ (validProfile : Bool), clientSvidAllowed false validProfile = false
#require_theorem OpenSesame.SourceTrustSelection.malformed_client_svid_is_refused :
  ∀ (matchingId : Bool), clientSvidAllowed matchingId false = false
#require_theorem OpenSesame.SourceTrustSelection.client_svid_requires_both :
  ∀ (matchingId validProfile : Bool), clientSvidAllowed matchingId validProfile = true ↔
    matchingId = true ∧ validProfile = true
#require_theorem OpenSesame.SourceTrustSelection.file_locator_rejects_injection :
  fileInjectionAllowed true true = false
#require_theorem OpenSesame.SourceTrustSelection.conflicting_sources_are_refused :
  sourcesAllowed true = false
#require_theorem OpenSesame.SourceTrustSelection.mismatched_locator_is_refused :
  locatorAllowed true false = false
#require_theorem OpenSesame.SourceTrustSelection.configured_and_injected_crls_are_refused :
  ∀ (nonempty single : Bool), crlsAllowed true true nonempty single = false
#require_theorem OpenSesame.SourceTrustSelection.empty_configured_crl_is_refused :
  ∀ (injected single : Bool), crlsAllowed true injected false single = false
#require_theorem OpenSesame.SourceTrustSelection.multiple_crls_are_refused :
  ∀ (configured injected nonempty : Bool), crlsAllowed configured injected nonempty false = false
#require_theorem OpenSesame.SourceTrustSelection.environment_other_requires_tls :
  ∀ (trust server crl minimum : Bool), environmentRequiresTls true trust server crl minimum = true
#require_theorem OpenSesame.SourceTrustSelection.retry_without_policy_is_refused :
  retryConfigurationAllowed false true = false
#require_theorem OpenSesame.SourceTrustSelection.nonassertive_plaintext_is_refused :
  environmentPlaintextAllowed false false = false
#require_theorem OpenSesame.SourceTrustSelection.environment_trust_requires_tls :
  ∀ (other server crl minimum : Bool), environmentRequiresTls other true server crl minimum = true
#require_theorem OpenSesame.SourceTrustSelection.environment_server_requires_tls :
  ∀ (other trust crl minimum : Bool), environmentRequiresTls other trust true crl minimum = true
#require_theorem OpenSesame.SourceTrustSelection.environment_crl_requires_tls :
  ∀ (other trust server minimum : Bool), environmentRequiresTls other trust server true minimum = true
#require_theorem OpenSesame.SourceTrustSelection.environment_minimum_requires_tls :
  ∀ (other trust server crl : Bool), environmentRequiresTls other trust server crl true = true
#require_theorem OpenSesame.SourceTrustSelection.invalid_security_flag_is_refused :
  ∀ (enabled : Bool), securityFlag false enabled = none
#require_theorem OpenSesame.SourceTrustSelection.plaintext_trust_is_refused :
  ∀ (identity server auth tlsFirst minimum : Bool), plaintextAllowed identity true server auth tlsFirst minimum = false
#require_theorem OpenSesame.SourceTrustSelection.plaintext_server_is_refused :
  ∀ (identity trust auth tlsFirst minimum : Bool), plaintextAllowed identity trust true auth tlsFirst minimum = false
#require_theorem OpenSesame.SourceTrustSelection.plaintext_nondefault_minimum_is_refused :
  ∀ (identity trust server auth tlsFirst : Bool), plaintextAllowed identity trust server auth tlsFirst true = false
