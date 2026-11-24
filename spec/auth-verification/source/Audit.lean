/- Independent theorem types: do not define these in terms of the policy names
   being audited, or a weakened policy would also weaken the audit. -/
namespace SourceAuth.Audit

example (safe present listed : Bool) (sameOrigin : Option Bool) :
    extractedCookie safe present listed sameOrigin = true ↔
      safe = true ∨ (present = true ∧ (listed = true ∨ sameOrigin = some true)) :=
  cookie_refines_policy safe present listed sameOrigin

example (isNull isUndefined suspended closed withdrawalPending : Bool) :
    extractedPrincipal isNull isUndefined suspended closed withdrawalPending = some true ↔
      isNull = false ∧ isUndefined = false ∧ suspended = false ∧ closed = false ∧
        withdrawalPending = false :=
  principal_refines_policy isNull isUndefined suspended closed withdrawalPending

example (isNull isUndefined suspended closed withdrawalPending : Bool) :
    extractedPrincipal isNull isUndefined suspended closed withdrawalPending ≠ none :=
  principal_never_throws isNull isUndefined suspended closed withdrawalPending

example (spent owner expired mismatch errorFlag : Bool) (code : CodeKind) :
    (extractedOidc spent owner expired mismatch errorFlag code).2 = some true ↔
      spent = false ∧ owner = true ∧ expired = false ∧ mismatch = false ∧
        errorFlag = false ∧ code = .bounded :=
  oidc_exchange_refines_policy spent owner expired mismatch errorFlag code

example (expired mismatch errorFlag : Bool) (code : CodeKind) :
    extractedOidcGuard expired mismatch errorFlag code ≠ none :=
  oidc_guard_never_dereferences_missing_code expired mismatch errorFlag code

example (spent owner expired mismatch errorFlag : Bool) (code : CodeKind) :
    (extractedOidc spent owner expired mismatch errorFlag code).1 = true :=
  oidc_completion_consumes spent owner expired mismatch errorFlag code

example (spent owner expired mismatch errorFlag : Bool) (code : CodeKind)
    (nextOwner nextExpired nextMismatch nextError : Bool) (nextCode : CodeKind) :
    (extractedOidc (extractedOidc spent owner expired mismatch errorFlag code).1
      nextOwner nextExpired nextMismatch nextError nextCode).2 = some false :=
  oidc_replay_cannot_exchange spent owner expired mismatch errorFlag code
    nextOwner nextExpired nextMismatch nextError nextCode

example (present owner expired : Bool) :
    (extractedEvidence present owner expired).2 = true ↔
      present = true ∧ owner = true ∧ expired = false :=
  evidence_refines_policy present owner expired

example (present owner expired : Bool) :
    (extractedEvidence present owner expired).1 = false :=
  evidence_always_consumed present owner expired

example (present owner expired nextOwner nextExpired : Bool) :
    (extractedEvidence (extractedEvidence present owner expired).1 nextOwner nextExpired).2 = false :=
  evidence_reentry_denied present owner expired nextOwner nextExpired

example (present : Bool) (requested : Option WebPurpose) (issued : WebPurpose) (principalOk : Bool) :
    extractedWebAuthn present requested issued principalOk = true ↔
      present = true ∧
      (webExpected requested = .authentication ∨ webExpected requested = .transaction) ∧
      issued = webExpected requested ∧ principalOk = true :=
  webauthn_guard_refines_policy present requested issued principalOk

example (present : Bool) (requested : Option WebPurpose) (principalOk : Bool) :
    extractedWebAuthn present requested .registration principalOk = false :=
  webauthn_registration_denied present requested principalOk

example (present : Bool) (issued : WebPurpose) (principalOk : Bool) :
    extractedWebAuthn present (some .other) issued principalOk = false :=
  webauthn_unknown_purpose_denied present issued principalOk

example (present : Bool) (issued : WebPurpose) (principalOk : Bool) :
    extractedWebAuthn present none issued principalOk =
      (present && (issued == WebPurpose.authentication) && principalOk) :=
  webauthn_default_is_authentication present issued principalOk

example (live reviewed principalPresent : Bool) :
    extractedClaimCompletion live reviewed principalPresent = true ↔
      live = true ∧ reviewed = true ∧ principalPresent = true :=
  claim_completion_refines_policy live reviewed principalPresent

example (live principalPresent : Bool) :
    extractedClaimCompletion live false principalPresent = false :=
  claim_completion_requires_review live principalPresent

example (live reviewed : Bool) :
    extractedClaimCompletion live reviewed false = false :=
  claim_completion_requires_principal live reviewed

example (live seen full : Bool) :
    (extractedSaml live seen full).1 = true ↔
      live = true ∧ seen = false ∧ full = false :=
  saml_claim_refines_policy live seen full

example (live full : Bool) : (extractedSaml live true full).1 = false :=
  saml_replay_denied live full

example (seen full : Bool) : (extractedSaml false seen full).1 = false :=
  saml_expiry_denied seen full

example (live seen : Bool) : (extractedSaml live seen true).1 = false :=
  saml_capacity_denied live seen

example (live seen full : Bool) (accepted : (extractedSaml live seen full).1 = true) :
    (extractedSaml live seen full).2 = true :=
  saml_accept_stores_key live seen full accepted

example (live seen full nextLive nextFull : Bool)
    (accepted : (extractedSaml live seen full).1 = true) :
    (extractedSaml nextLive (extractedSaml live seen full).2 nextFull).1 = false :=
  saml_replay_after_accept live seen full nextLive nextFull accepted

example (present verified sameGeneration counterAllowed : Bool) :
    extractedPasskeyConfirmation present verified sameGeneration counterAllowed = true ↔
      present = true ∧ verified = true ∧ sameGeneration = true ∧ counterAllowed = true :=
  passkey_confirmation_refines_policy present verified sameGeneration counterAllowed

example (present verified counterAllowed : Bool) :
    extractedPasskeyConfirmation present verified false counterAllowed = false :=
  passkey_replacement_denied present verified counterAllowed

example (verified sameGeneration counterAllowed : Bool) :
    extractedPasskeyConfirmation false verified sameGeneration counterAllowed = false :=
  passkey_absent_denied verified sameGeneration counterAllowed

example (present sameGeneration counterAllowed : Bool) :
    extractedPasskeyConfirmation present false sameGeneration counterAllowed = false :=
  passkey_verifier_rejection_denied present sameGeneration counterAllowed

example (previous : Nat) :
    extractedPasskeyCounter previous (some 0) = true ↔ previous = 0 :=
  passkey_zero_counter previous

example (previous next : Nat) (positive : next > 0)
    (accepted : extractedPasskeyCounter previous (some next) = true) : previous < next :=
  passkey_positive_counter_advances previous next positive accepted

example (orgEligible byoActive : Bool) :
    extractedIssuerResolution true true orgEligible byoActive = .static :=
  issuer_static_precedence orgEligible byoActive

example (byoActive : Bool) :
    extractedIssuerResolution true false true byoActive = .org :=
  issuer_organization_precedence byoActive

example (nonempty staticTrusted orgEligible byoActive : Bool)
    (selected : extractedIssuerResolution nonempty staticTrusted orgEligible byoActive = .byo) :
    byoActive = true :=
  issuer_byo_requires_active nonempty staticTrusted orgEligible byoActive selected

example (nonempty staticTrusted orgEligible byoActive : Bool)
    (selected : extractedIssuerResolution nonempty staticTrusted orgEligible byoActive = .org) :
    orgEligible = true :=
  issuer_organization_requires_admission nonempty staticTrusted orgEligible byoActive selected

example (nonempty : Bool) :
    extractedIssuerResolution nonempty false false false = .untrusted :=
  issuer_no_match_denied nonempty

example (staticTrusted orgEligible byoActive : Bool) :
    extractedIssuerResolution false staticTrusted orgEligible byoActive = .untrusted :=
  issuer_blank_denied staticTrusted orgEligible byoActive

example (canonical modernValid legacyValid providerPresent knownFieldsOnly : Bool) :
    extractedPendingAdmission canonical modernValid legacyValid providerPresent knownFieldsOnly = true ↔
      canonical = true ∧
        (modernValid = true ∨
          (legacyValid = true ∧ providerPresent = true ∧ knownFieldsOnly = true)) :=
  pending_admission_refines_policy canonical modernValid legacyValid providerPresent knownFieldsOnly

example (modernValid legacyValid providerPresent knownFieldsOnly : Bool) :
    extractedPendingAdmission false modernValid legacyValid providerPresent knownFieldsOnly = false :=
  pending_noncanonical_denied modernValid legacyValid providerPresent knownFieldsOnly

example (legacyValid knownFieldsOnly : Bool) :
    extractedPendingAdmission true false legacyValid false knownFieldsOnly = false :=
  pending_legacy_provider_required legacyValid knownFieldsOnly

example (legacyValid providerPresent : Bool) :
    extractedPendingAdmission true false legacyValid providerPresent false = false :=
  pending_legacy_known_fields_required legacyValid providerPresent

example (legacyValid providerPresent knownFieldsOnly : Bool) :
    extractedPendingAdmission true true legacyValid providerPresent knownFieldsOnly = true :=
  pending_modern_signature_admitted legacyValid providerPresent knownFieldsOnly

example (providerPresent knownFieldsOnly : Bool) :
    extractedPendingAdmission true false false providerPresent knownFieldsOnly = false :=
  pending_no_signature_denied providerPresent knownFieldsOnly

example (pendingOidc currentOidc single hasProvenance sameSource sameId currentStatic : Bool) :
    extractedFederatedTrust pendingOidc currentOidc single hasProvenance sameSource sameId currentStatic = true ↔
      pendingOidc = true ∧ currentOidc = true ∧ single = true ∧
        (if hasProvenance then sameSource = true ∧ sameId = true else currentStatic = true) :=
  trust_binding_refines_policy pendingOidc currentOidc single hasProvenance
    sameSource sameId currentStatic

example (pendingOidc currentOidc single sameId currentStatic : Bool) :
    extractedFederatedTrust pendingOidc currentOidc single true false sameId currentStatic = false :=
  trust_source_rebound_denied pendingOidc currentOidc single sameId currentStatic

example (pendingOidc currentOidc single sameSource currentStatic : Bool) :
    extractedFederatedTrust pendingOidc currentOidc single true sameSource false currentStatic = false :=
  trust_record_replacement_denied pendingOidc currentOidc single sameSource currentStatic

example (pendingOidc currentOidc single sameSource sameId : Bool) :
    extractedFederatedTrust pendingOidc currentOidc single false sameSource sameId false = false :=
  trust_legacy_dynamic_denied pendingOidc currentOidc single sameSource sameId

example (currentOidc single hasProvenance sameSource sameId currentStatic : Bool) :
    extractedFederatedTrust false currentOidc single hasProvenance sameSource sameId currentStatic = false :=
  trust_oauth2_pending_denied currentOidc single hasProvenance sameSource sameId currentStatic

example (pendingOidc currentOidc hasProvenance sameSource sameId currentStatic : Bool) :
    extractedFederatedTrust pendingOidc currentOidc false hasProvenance sameSource sameId currentStatic = false :=
  trust_ambiguous_provenance_denied pendingOidc currentOidc hasProvenance sameSource sameId currentStatic

example (pendingOidc single hasProvenance sameSource sameId currentStatic : Bool) :
    extractedFederatedTrust pendingOidc false single hasProvenance sameSource sameId currentStatic = false :=
  trust_non_oidc_authority_denied pendingOidc single hasProvenance sameSource sameId currentStatic

example (source target : Status) :
    extractedTransition source target = true ↔
      source = .pending ∧ target ≠ .pending :=
  transition_refines_policy source target

example (source target : Status) (terminal : source ≠ .pending) :
    extractedTransition source target = false :=
  terminal_has_no_transition source target terminal

example (source : Status) : extractedTransition source .pending = false :=
  no_transition_to_pending source

example (source target : Device) :
    extractedDevice source target = (match source, target with
    | .pending, .approved => true
    | .pending, .denied => true
    | .pending, .expired => true
    | .approved, .consumed => true
    | .approved, .expired => true
    | _, _ => false) :=
  device_graph_refines_policy source target

example (source target : Claim) :
    extractedClaim source target = (match source, target with
    | .pending, .presented => true
    | .pending, .revoked => true
    | .pending, .expired => true
    | .presented, .authenticated => true
    | .presented, .revoked => true
    | .presented, .expired => true
    | .authenticated, .reviewed => true
    | .authenticated, .revoked => true
    | .authenticated, .expired => true
    | .reviewed, .completed => true
    | .reviewed, .denied => true
    | .reviewed, .revoked => true
    | .reviewed, .expired => true
    | _, _ => false) :=
  claim_graph_refines_policy source target

example (source target : Agent) :
    extractedAgent source target = (match source, target with
    | .unclaimed, .claim_pending => true
    | .unclaimed, .expired => true
    | .unclaimed, .revoked => true
    | .claim_pending, .claimed => true
    | .claim_pending, .claim_pending => true
    | .claim_pending, .expired => true
    | .claim_pending, .revoked => true
    | .claimed, .revoked => true
    | _, _ => false) :=
  agent_graph_refines_policy source target

example (source target : Resource) :
    extractedResource source target = (match source, target with
    | .provisional, .active => true
    | .provisional, .expired => true
    | .provisional, .quarantined => true
    | .active, .expired => true
    | .active, .deleting => true
    | .active, .quarantined => true
    | .expired, .deleting => true
    | .expired, .quarantined => true
    | .quarantined, .deleting => true
    | .quarantined, .expired => true
    | .deleting, .deleted => true
    | _, _ => false) :=
  resource_graph_refines_policy source target

end SourceAuth.Audit

#print axioms SourceAuth.cookie_refines_policy
#print axioms SourceAuth.principal_refines_policy
#print axioms SourceAuth.principal_never_throws
#print axioms SourceAuth.oidc_exchange_refines_policy
#print axioms SourceAuth.oidc_guard_never_dereferences_missing_code
#print axioms SourceAuth.oidc_completion_consumes
#print axioms SourceAuth.oidc_replay_cannot_exchange
#print axioms SourceAuth.evidence_refines_policy
#print axioms SourceAuth.evidence_always_consumed
#print axioms SourceAuth.evidence_reentry_denied
#print axioms SourceAuth.transition_refines_policy
#print axioms SourceAuth.terminal_has_no_transition
#print axioms SourceAuth.no_transition_to_pending

#print axioms SourceAuth.device_graph_refines_policy
#print axioms SourceAuth.claim_graph_refines_policy
#print axioms SourceAuth.agent_graph_refines_policy
#print axioms SourceAuth.resource_graph_refines_policy
#print axioms SourceAuth.webauthn_guard_refines_policy
#print axioms SourceAuth.webauthn_registration_denied
#print axioms SourceAuth.webauthn_unknown_purpose_denied
#print axioms SourceAuth.webauthn_default_is_authentication
#print axioms SourceAuth.claim_completion_refines_policy
#print axioms SourceAuth.claim_completion_requires_review
#print axioms SourceAuth.claim_completion_requires_principal
#print axioms SourceAuth.saml_claim_refines_policy
#print axioms SourceAuth.saml_replay_denied
#print axioms SourceAuth.saml_expiry_denied
#print axioms SourceAuth.saml_capacity_denied
#print axioms SourceAuth.saml_accept_stores_key
#print axioms SourceAuth.saml_replay_after_accept
#print axioms SourceAuth.passkey_confirmation_refines_policy
#print axioms SourceAuth.passkey_replacement_denied
#print axioms SourceAuth.passkey_absent_denied
#print axioms SourceAuth.passkey_verifier_rejection_denied
#print axioms SourceAuth.passkey_zero_counter
#print axioms SourceAuth.passkey_positive_counter_advances
#print axioms SourceAuth.issuer_static_precedence
#print axioms SourceAuth.issuer_organization_precedence
#print axioms SourceAuth.issuer_byo_requires_active
#print axioms SourceAuth.issuer_organization_requires_admission
#print axioms SourceAuth.issuer_no_match_denied
#print axioms SourceAuth.issuer_blank_denied
#print axioms SourceAuth.pending_admission_refines_policy
#print axioms SourceAuth.pending_noncanonical_denied
#print axioms SourceAuth.pending_legacy_provider_required
#print axioms SourceAuth.pending_legacy_known_fields_required
#print axioms SourceAuth.pending_modern_signature_admitted
#print axioms SourceAuth.pending_no_signature_denied
#print axioms SourceAuth.trust_binding_refines_policy
#print axioms SourceAuth.trust_source_rebound_denied
#print axioms SourceAuth.trust_record_replacement_denied
#print axioms SourceAuth.trust_legacy_dynamic_denied
#print axioms SourceAuth.trust_oauth2_pending_denied
#print axioms SourceAuth.trust_ambiguous_provenance_denied
#print axioms SourceAuth.trust_non_oidc_authority_denied
