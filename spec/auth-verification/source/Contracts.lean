import Std

/- The verifier inserts definitions translated from the checked TypeScript
   source at the marker. The policy below is independent of those definitions.
   See README.md for the trusted translator and runtime assumptions. -/
namespace SourceAuth

inductive Status where
  | pending | approved | denied | cancelled | expired
  deriving DecidableEq, Repr

inductive CodeKind where
  | missing | empty | bounded | oversized
  deriving DecidableEq, Repr

inductive WebPurpose where
  | authentication | transaction | registration | other
  deriving DecidableEq, BEq, Repr

def webExpected : Option WebPurpose → WebPurpose
  | none => .authentication
  | some purpose => purpose

/- Option.none represents a null/undefined property access. The second
   operand is discarded when JavaScript's Boolean operator short-circuits. -/
def jsAnd (left right : Option Bool) : Option Bool :=
  match left with
  | none => none
  | some false => some false
  | some true => right

def jsOr (left right : Option Bool) : Option Bool :=
  match left with
  | none => none
  | some true => some true
  | some false => right

def jsNot (value : Option Bool) : Option Bool := value.map not

def codePresent : CodeKind → Bool
  | .missing | .empty => false
  | .bounded | .oversized => true

def codeTooLong : CodeKind → Option Bool
  | .missing => none
  | .empty | .bounded => some false
  | .oversized => some true

inductive Device where
  | pending | approved | denied | expired | consumed
  deriving DecidableEq, Repr

inductive Claim where
  | pending | presented | authenticated | reviewed | completed | denied | revoked | expired
  deriving DecidableEq, Repr

inductive Agent where
  | unclaimed | claim_pending | claimed | expired | revoked
  deriving DecidableEq, Repr

inductive Resource where
  | provisional | active | expired | deleting | deleted | quarantined
  deriving DecidableEq, Repr

inductive TrustChoice where
  | untrusted | static | org | byo
  deriving DecidableEq, Repr

-- SOURCE_DEFINITIONS

def cookiePolicy (safe present listed : Bool) (sameOrigin : Option Bool) : Prop :=
  safe = true ∨ (present = true ∧ (listed = true ∨ sameOrigin = some true))

theorem cookie_refines_policy (safe present listed : Bool) (sameOrigin : Option Bool) :
    extractedCookie safe present listed sameOrigin = true ↔
      cookiePolicy safe present listed sameOrigin := by
  cases safe <;> cases present <;> cases listed <;> cases sameOrigin <;>
    simp [extractedCookie, cookiePolicy]

def principalPolicy (isNull isUndefined suspended closed : Bool) : Prop :=
  isNull = false ∧ isUndefined = false ∧ suspended = false ∧ closed = false

theorem principal_refines_policy (isNull isUndefined suspended closed : Bool) :
    extractedPrincipal isNull isUndefined suspended closed = some true ↔
      principalPolicy isNull isUndefined suspended closed := by
  cases isNull <;> cases isUndefined <;> cases suspended <;> cases closed <;>
    simp [extractedPrincipal, principalPolicy, jsAnd]

theorem principal_never_throws (isNull isUndefined suspended closed : Bool) :
    extractedPrincipal isNull isUndefined suspended closed ≠ none := by
  cases isNull <;> cases isUndefined <;> cases suspended <;> cases closed <;>
    simp [extractedPrincipal, jsAnd]

def oidcPolicy (spent owner expired mismatch errorFlag : Bool) (code : CodeKind) : Prop :=
  spent = false ∧ owner = true ∧ expired = false ∧ mismatch = false ∧
    errorFlag = false ∧ code = .bounded

theorem oidc_exchange_refines_policy
    (spent owner expired mismatch errorFlag : Bool) (code : CodeKind) :
    (extractedOidc spent owner expired mismatch errorFlag code).2 = some true ↔
      oidcPolicy spent owner expired mismatch errorFlag code := by
  cases spent <;> cases owner <;> cases expired <;> cases mismatch <;>
    cases errorFlag <;> cases code <;>
    simp [extractedOidc, extractedOidcGuard, oidcPolicy, jsOr, jsNot, codePresent, codeTooLong]

theorem oidc_guard_never_dereferences_missing_code
    (expired mismatch errorFlag : Bool) (code : CodeKind) :
    extractedOidcGuard expired mismatch errorFlag code ≠ none := by
  cases expired <;> cases mismatch <;> cases errorFlag <;> cases code <;>
    simp [extractedOidcGuard, jsOr, jsNot, codePresent, codeTooLong]

theorem oidc_completion_consumes
    (spent owner expired mismatch errorFlag : Bool) (code : CodeKind) :
    (extractedOidc spent owner expired mismatch errorFlag code).1 = true := by
  cases spent <;> cases owner <;> simp [extractedOidc]

theorem oidc_replay_cannot_exchange
    (spent owner expired mismatch errorFlag : Bool) (code : CodeKind)
    (nextOwner nextExpired nextMismatch nextError : Bool) (nextCode : CodeKind) :
    (extractedOidc (extractedOidc spent owner expired mismatch errorFlag code).1
      nextOwner nextExpired nextMismatch nextError nextCode).2 = some false := by
  cases spent <;> cases owner <;> simp [extractedOidc]

theorem evidence_refines_policy (present owner expired : Bool) :
    (extractedEvidence present owner expired).2 = true ↔
      present = true ∧ owner = true ∧ expired = false := by
  cases present <;> cases owner <;> cases expired <;> simp [extractedEvidence]

theorem evidence_always_consumed (present owner expired : Bool) :
    (extractedEvidence present owner expired).1 = false := by
  cases present <;> cases owner <;> cases expired <;> simp [extractedEvidence]

theorem evidence_reentry_denied (present owner expired nextOwner nextExpired : Bool) :
    (extractedEvidence (extractedEvidence present owner expired).1 nextOwner nextExpired).2 = false := by
  cases present <;> cases owner <;> cases expired <;> simp [extractedEvidence]

theorem webauthn_guard_refines_policy
    (present : Bool) (requested : Option WebPurpose) (issued : WebPurpose) (principalOk : Bool) :
    extractedWebAuthn present requested issued principalOk = true ↔
      present = true ∧
      (webExpected requested = .authentication ∨ webExpected requested = .transaction) ∧
      issued = webExpected requested ∧ principalOk = true := by
  cases requested with
  | none => cases issued <;> cases present <;> cases principalOk <;> simp [extractedWebAuthn, webExpected] <;> decide
  | some value => cases value <;> cases issued <;> cases present <;> cases principalOk <;> simp [extractedWebAuthn, webExpected] <;> decide

theorem webauthn_registration_denied
    (present : Bool) (requested : Option WebPurpose) (principalOk : Bool) :
    extractedWebAuthn present requested .registration principalOk = false := by
  cases requested with
  | none => cases present <;> cases principalOk <;> rfl
  | some value => cases value <;> cases present <;> cases principalOk <;> rfl

theorem webauthn_unknown_purpose_denied
    (present : Bool) (issued : WebPurpose) (principalOk : Bool) :
    extractedWebAuthn present (some .other) issued principalOk = false := by
  rfl

theorem webauthn_default_is_authentication
    (present : Bool) (issued : WebPurpose) (principalOk : Bool) :
    extractedWebAuthn present none issued principalOk =
      (present && (issued == WebPurpose.authentication) && principalOk) := by
  rfl

theorem claim_completion_refines_policy (live reviewed principalPresent : Bool) :
    extractedClaimCompletion live reviewed principalPresent = true ↔
      live = true ∧ reviewed = true ∧ principalPresent = true := by
  cases live <;> cases reviewed <;> cases principalPresent <;> simp [extractedClaimCompletion]

theorem claim_completion_requires_review (live principalPresent : Bool) :
    extractedClaimCompletion live false principalPresent = false := by
  cases live <;> rfl

theorem claim_completion_requires_principal (live reviewed : Bool) :
    extractedClaimCompletion live reviewed false = false := by
  cases live <;> cases reviewed <;> rfl

theorem saml_claim_refines_policy (live seen full : Bool) :
    (extractedSaml live seen full).1 = true ↔
      live = true ∧ seen = false ∧ full = false := by
  cases live <;> cases seen <;> cases full <;> simp [extractedSaml]

theorem saml_replay_denied (live full : Bool) :
    (extractedSaml live true full).1 = false := by
  cases live <;> rfl

theorem saml_expiry_denied (seen full : Bool) :
    (extractedSaml false seen full).1 = false := by
  rfl

theorem saml_capacity_denied (live seen : Bool) :
    (extractedSaml live seen true).1 = false := by
  cases live <;> cases seen <;> rfl

theorem saml_accept_stores_key (live seen full : Bool)
    (accepted : (extractedSaml live seen full).1 = true) :
    (extractedSaml live seen full).2 = true := by
  cases live <;> cases seen <;> cases full <;> simp_all [extractedSaml]

theorem saml_replay_after_accept (live seen full nextLive nextFull : Bool)
    (accepted : (extractedSaml live seen full).1 = true) :
    (extractedSaml nextLive (extractedSaml live seen full).2 nextFull).1 = false := by
  cases live <;> cases seen <;> cases full <;> cases nextLive <;> cases nextFull <;> simp_all [extractedSaml]

theorem passkey_confirmation_refines_policy (present verified sameGeneration counterAllowed : Bool) :
    extractedPasskeyConfirmation present verified sameGeneration counterAllowed = true ↔
      present = true ∧ verified = true ∧ sameGeneration = true ∧ counterAllowed = true := by
  cases present <;> cases verified <;> cases sameGeneration <;> cases counterAllowed <;>
    simp [extractedPasskeyConfirmation]

theorem passkey_replacement_denied (present verified counterAllowed : Bool) :
    extractedPasskeyConfirmation present verified false counterAllowed = false := by
  cases present <;> cases verified <;> rfl

theorem passkey_absent_denied (verified sameGeneration counterAllowed : Bool) :
    extractedPasskeyConfirmation false verified sameGeneration counterAllowed = false := by
  rfl

theorem passkey_verifier_rejection_denied (present sameGeneration counterAllowed : Bool) :
    extractedPasskeyConfirmation present false sameGeneration counterAllowed = false := by
  cases present <;> rfl

theorem passkey_zero_counter (previous : Nat) :
    extractedPasskeyCounter previous (some 0) = true ↔ previous = 0 := by
  simp [extractedPasskeyCounter]

theorem passkey_positive_counter_advances (previous next : Nat) (positive : next > 0)
    (accepted : extractedPasskeyCounter previous (some next) = true) : previous < next := by
  cases next with
  | zero => simp at positive
  | succ next => simpa [extractedPasskeyCounter] using accepted

theorem issuer_static_precedence (orgEligible byoActive : Bool) :
    extractedIssuerResolution true true orgEligible byoActive = .static := by
  rfl

theorem issuer_organization_precedence (byoActive : Bool) :
    extractedIssuerResolution true false true byoActive = .org := by
  rfl

theorem issuer_byo_requires_active (nonempty staticTrusted orgEligible byoActive : Bool)
    (selected : extractedIssuerResolution nonempty staticTrusted orgEligible byoActive = .byo) :
    byoActive = true := by
  cases nonempty <;> cases staticTrusted <;> cases orgEligible <;> cases byoActive <;>
    simp_all [extractedIssuerResolution]

theorem issuer_organization_requires_admission (nonempty staticTrusted orgEligible byoActive : Bool)
    (selected : extractedIssuerResolution nonempty staticTrusted orgEligible byoActive = .org) :
    orgEligible = true := by
  cases nonempty <;> cases staticTrusted <;> cases orgEligible <;> cases byoActive <;>
    simp_all [extractedIssuerResolution]

theorem issuer_no_match_denied (nonempty : Bool) :
    extractedIssuerResolution nonempty false false false = .untrusted := by
  cases nonempty <;> rfl

theorem issuer_blank_denied (staticTrusted orgEligible byoActive : Bool) :
    extractedIssuerResolution false staticTrusted orgEligible byoActive = .untrusted := by
  rfl

theorem pending_admission_refines_policy (modernValid legacyValid orgAbsent byoAbsent : Bool) :
    extractedPendingAdmission modernValid legacyValid orgAbsent byoAbsent = true ↔
      modernValid = true ∨ (legacyValid = true ∧ orgAbsent = true ∧ byoAbsent = true) := by
  cases modernValid <;> cases legacyValid <;> cases orgAbsent <;> cases byoAbsent <;>
    simp [extractedPendingAdmission]

theorem pending_legacy_org_denied (legacyValid byoAbsent : Bool) :
    extractedPendingAdmission false legacyValid false byoAbsent = false := by
  cases legacyValid <;> rfl

theorem pending_legacy_byo_denied (legacyValid orgAbsent : Bool) :
    extractedPendingAdmission false legacyValid orgAbsent false = false := by
  cases legacyValid <;> cases orgAbsent <;> rfl

theorem pending_modern_signature_admitted (legacyValid orgAbsent byoAbsent : Bool) :
    extractedPendingAdmission true legacyValid orgAbsent byoAbsent = true := by
  rfl

theorem pending_no_signature_denied (orgAbsent byoAbsent : Bool) :
    extractedPendingAdmission false false orgAbsent byoAbsent = false := by
  rfl

def trustBindingPolicy (pendingOidc currentOidc single hasProvenance sameSource sameId
    currentStatic : Bool) : Prop :=
  pendingOidc = true ∧ currentOidc = true ∧ single = true ∧
    (if hasProvenance then sameSource = true ∧ sameId = true else currentStatic = true)
theorem trust_binding_refines_policy (pendingOidc currentOidc single hasProvenance
    sameSource sameId currentStatic : Bool) :
    extractedFederatedTrust pendingOidc currentOidc single hasProvenance sameSource sameId currentStatic = true ↔
      trustBindingPolicy pendingOidc currentOidc single hasProvenance sameSource sameId currentStatic := by
  cases pendingOidc <;> cases currentOidc <;> cases single <;> cases hasProvenance <;>
    cases sameSource <;> cases sameId <;> cases currentStatic <;>
    simp [extractedFederatedTrust, trustBindingPolicy]
theorem trust_source_rebound_denied (pendingOidc currentOidc single sameId currentStatic : Bool) :
    extractedFederatedTrust pendingOidc currentOidc single true false sameId currentStatic = false := by
  cases pendingOidc <;> cases currentOidc <;> cases single <;> cases sameId <;> cases currentStatic <;> rfl
theorem trust_record_replacement_denied (pendingOidc currentOidc single sameSource currentStatic : Bool) :
    extractedFederatedTrust pendingOidc currentOidc single true sameSource false currentStatic = false := by
  cases pendingOidc <;> cases currentOidc <;> cases single <;> cases sameSource <;> cases currentStatic <;> rfl
theorem trust_legacy_dynamic_denied (pendingOidc currentOidc single sameSource sameId : Bool) :
    extractedFederatedTrust pendingOidc currentOidc single false sameSource sameId false = false := by
  cases pendingOidc <;> cases currentOidc <;> cases single <;> cases sameSource <;> cases sameId <;> rfl
theorem trust_oauth2_pending_denied (currentOidc single hasProvenance sameSource sameId
    currentStatic : Bool) :
    extractedFederatedTrust false currentOidc single hasProvenance sameSource sameId currentStatic = false := by rfl
theorem trust_ambiguous_provenance_denied (pendingOidc currentOidc hasProvenance
    sameSource sameId currentStatic : Bool) :
    extractedFederatedTrust pendingOidc currentOidc false hasProvenance sameSource sameId currentStatic = false := by
  cases pendingOidc <;> cases currentOidc <;> rfl
theorem trust_non_oidc_authority_denied (pendingOidc single hasProvenance sameSource sameId
    currentStatic : Bool) :
    extractedFederatedTrust pendingOidc false single hasProvenance sameSource sameId currentStatic = false := by
  cases pendingOidc <;> rfl
def transitionPolicy (source target : Status) : Prop :=
  source = .pending ∧ target ≠ .pending

theorem transition_refines_policy (source target : Status) :
    extractedTransition source target = true ↔ transitionPolicy source target := by
  cases source <;> cases target <;> simp [extractedTransition, transitionPolicy]

theorem terminal_has_no_transition (source target : Status) (terminal : source ≠ .pending) :
    extractedTransition source target = false := by
  cases source <;> cases target <;> simp_all [extractedTransition]

theorem no_transition_to_pending (source : Status) :
    extractedTransition source .pending = false := by
  cases source <;> decide

def devicePolicy (source target : Device) : Bool :=
  match source, target with
    | .pending, .approved => true
    | .pending, .denied => true
    | .pending, .expired => true
    | .approved, .consumed => true
    | .approved, .expired => true
    | _, _ => false

theorem device_graph_refines_policy (source target : Device) :
    extractedDevice source target = devicePolicy source target := by
  cases source <;> cases target <;> rfl

def claimPolicy (source target : Claim) : Bool :=
  match source, target with
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
    | _, _ => false

theorem claim_graph_refines_policy (source target : Claim) :
    extractedClaim source target = claimPolicy source target := by
  cases source <;> cases target <;> rfl

def agentPolicy (source target : Agent) : Bool :=
  match source, target with
    | .unclaimed, .claim_pending => true
    | .unclaimed, .expired => true
    | .unclaimed, .revoked => true
    | .claim_pending, .claimed => true
    | .claim_pending, .claim_pending => true
    | .claim_pending, .expired => true
    | .claim_pending, .revoked => true
    | .claimed, .revoked => true
    | _, _ => false

theorem agent_graph_refines_policy (source target : Agent) :
    extractedAgent source target = agentPolicy source target := by
  cases source <;> cases target <;> rfl

def resourcePolicy (source target : Resource) : Bool :=
  match source, target with
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
    | _, _ => false

theorem resource_graph_refines_policy (source target : Resource) :
    extractedResource source target = resourcePolicy source target := by
  cases source <;> cases target <;> rfl

end SourceAuth
