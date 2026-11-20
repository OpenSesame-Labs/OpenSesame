import Lean

set_option autoImplicit false

namespace OpenSesame.SourceTrustSelection

/-- A source-selected listener admits its requested bundle only when the
    generation-bound source view exists and the bundle is present, carries the
    required kind, has the requested label and names the configured domain. -/
def choose (fresh present spiffeKind matchingProfile matchingDomain : Bool) : Bool :=
  fresh && present && spiffeKind && matchingProfile && matchingDomain

theorem stale_view_is_refused (present spiffeKind matchingProfile matchingDomain : Bool) :
    choose false present spiffeKind matchingProfile matchingDomain = false := by
  simp [choose]

theorem missing_source_is_refused (fresh spiffeKind matchingProfile matchingDomain : Bool) :
    choose fresh false spiffeKind matchingProfile matchingDomain = false := by
  simp [choose]

theorem wrong_kind_is_refused (fresh present matchingProfile matchingDomain : Bool) :
    choose fresh present false matchingProfile matchingDomain = false := by
  simp [choose]

theorem wrong_profile_is_refused (fresh present spiffeKind matchingDomain : Bool) :
    choose fresh present spiffeKind false matchingDomain = false := by
  simp [choose]

theorem wrong_domain_is_refused (fresh present spiffeKind matchingProfile : Bool) :
    choose fresh present spiffeKind matchingProfile false = false := by
  simp [choose]

theorem selection_requires_all (fresh present spiffeKind matchingProfile matchingDomain : Bool) :
    choose fresh present spiffeKind matchingProfile matchingDomain = true ↔
      fresh = true ∧ present = true ∧ spiffeKind = true ∧
      matchingProfile = true ∧ matchingDomain = true := by
  simp [choose, and_assoc]

theorem complete_source_is_accepted : choose true true true true true = true := by
  rfl

/-- Abstract accepted NATS state. Numbers are opaque identities for a
    session, injected material and public view; they are not credentials. -/
structure RotationSnapshot where
  session : Nat
  material : Nat
  view : Nat
deriving DecidableEq

def selectedMaterial (current : Nat) (offered : Option Nat) : Nat :=
  offered.getD current

/-- A failed open leaves the snapshot alone. A successful, serialized
    commit publishes the proposed session, selected material and view. -/
def rotateSnapshot (old : RotationSnapshot) (session view : Nat)
    (offered : Option Nat) (succeeded : Bool) : RotationSnapshot :=
  if succeeded then ⟨session, selectedMaterial old.material offered, view⟩ else old

theorem failed_rotation_keeps_state (old : RotationSnapshot) (session view : Nat)
    (offered : Option Nat) : rotateSnapshot old session view offered false = old := by
  rfl

theorem explicit_material_is_committed (old : RotationSnapshot) (session view material : Nat) :
    (rotateSnapshot old session view (some material) true).material = material := by
  rfl

theorem implicit_material_is_retained (old : RotationSnapshot) (session view : Nat) :
    (rotateSnapshot old session view none true).material = old.material := by
  rfl

theorem successful_rotation_publishes_session_and_view (old : RotationSnapshot)
    (session view : Nat) (offered : Option Nat) :
    (rotateSnapshot old session view offered true).session = session ∧
    (rotateSnapshot old session view offered true).view = view := by
  exact ⟨rfl, rfl⟩

theorem implicit_after_explicit_reuses_material (old : RotationSnapshot)
    (firstSession firstView secondSession secondView material : Nat) :
    (rotateSnapshot (rotateSnapshot old firstSession firstView (some material) true)
      secondSession secondView none true).material = material := by
  rfl

theorem later_serialized_success_controls_view (old : RotationSnapshot)
    (firstSession firstView secondSession secondView : Nat)
    (firstMaterial secondMaterial : Option Nat) (firstSucceeded : Bool) :
    (rotateSnapshot (rotateSnapshot old firstSession firstView firstMaterial firstSucceeded)
      secondSession secondView secondMaterial true).view = secondView := by
  rfl

/-- One abstract certificate-verification gate, before the real verifier.
    Consuming the gate does not imply that certificate validation succeeds. -/
def handshakeAllowed (spent : Bool) : Bool := !spent

def consumeHandshake (_spent : Bool) : Bool := true

theorem fresh_handshake_gate_admits : handshakeAllowed false = true := by
  rfl

theorem spent_handshake_gate_refuses : handshakeAllowed true = false := by
  rfl

theorem consumed_handshake_gate_refuses (spent : Bool) :
    handshakeAllowed (consumeHandshake spent) = false := by
  rfl

def reconnectLimit (injected : Bool) (requested : Option Nat) : Option Nat :=
  if injected then some 1 else requested

theorem injected_reconnect_is_capped (requested : Option Nat) :
    reconnectLimit true requested = some 1 := by
  rfl

theorem ordinary_reconnect_limit_is_preserved (requested : Option Nat) :
    reconnectLimit false requested = requested := by
  rfl

def identityAllowed (configured supplied : Bool) : Bool := !supplied || configured

theorem unrequested_identity_is_refused : identityAllowed false true = false := by
  rfl

/-- For a configured SPIFFE client locator, the certificate's canonical ID
    must match and its independently checked SVID profile must be valid. -/
def clientSvidAllowed (matchingId validProfile : Bool) : Bool := matchingId && validProfile

theorem wrong_client_id_is_refused (validProfile : Bool) :
    clientSvidAllowed false validProfile = false := by
  simp [clientSvidAllowed]

theorem malformed_client_svid_is_refused (matchingId : Bool) :
    clientSvidAllowed matchingId false = false := by
  simp [clientSvidAllowed]

theorem client_svid_requires_both (matchingId validProfile : Bool) :
    clientSvidAllowed matchingId validProfile = true ↔
      matchingId = true ∧ validProfile = true := by
  simp [clientSvidAllowed]

def fileInjectionAllowed (fileBacked supplied : Bool) : Bool := !fileBacked || !supplied

theorem file_locator_rejects_injection : fileInjectionAllowed true true = false := by
  rfl

def sourcesAllowed (conflicting : Bool) : Bool := !conflicting

theorem conflicting_sources_are_refused : sourcesAllowed true = false := by
  rfl

def locatorAllowed (present matchingReference : Bool) : Bool := !present || matchingReference

theorem mismatched_locator_is_refused : locatorAllowed true false = false := by
  rfl

/-- `single` means at most one supplied CRL. File readability and parsing
    are separate preconditions; a configured file must also be nonempty. -/
def crlsAllowed (configured injected nonempty single : Bool) : Bool :=
  if configured then !injected && nonempty && single else single

theorem configured_and_injected_crls_are_refused (nonempty single : Bool) :
    crlsAllowed true true nonempty single = false := by
  simp [crlsAllowed]

theorem empty_configured_crl_is_refused (injected single : Bool) :
    crlsAllowed true injected false single = false := by
  simp [crlsAllowed]

theorem multiple_crls_are_refused (configured injected nonempty : Bool) :
    crlsAllowed configured injected nonempty false = false := by
  cases configured <;> simp [crlsAllowed]

def environmentRequiresTls (other trust server crl explicitMinimum : Bool) : Bool :=
  other || trust || server || crl || explicitMinimum

def retryConfigurationAllowed (policyPresent retryPresent : Bool) : Bool :=
  policyPresent || !retryPresent

theorem retry_without_policy_is_refused : retryConfigurationAllowed false true = false := by
  rfl

def environmentPlaintextAllowed (tlsRequired explicitFalse : Bool) : Bool :=
  tlsRequired || explicitFalse

theorem nonassertive_plaintext_is_refused : environmentPlaintextAllowed false false = false := by
  rfl

theorem environment_other_requires_tls (trust server crl minimum : Bool) :
    environmentRequiresTls true trust server crl minimum = true := by
  simp [environmentRequiresTls]

theorem environment_trust_requires_tls (other server crl minimum : Bool) :
    environmentRequiresTls other true server crl minimum = true := by
  simp [environmentRequiresTls]

theorem environment_server_requires_tls (other trust crl minimum : Bool) :
    environmentRequiresTls other trust true crl minimum = true := by
  simp [environmentRequiresTls]

theorem environment_crl_requires_tls (other trust server minimum : Bool) :
    environmentRequiresTls other trust server true minimum = true := by
  simp [environmentRequiresTls]

theorem environment_minimum_requires_tls (other trust server crl : Bool) :
    environmentRequiresTls other trust server crl true = true := by
  simp [environmentRequiresTls]

/-- `none` represents a rejected configuration rather than a false flag. -/
def securityFlag (valid enabled : Bool) : Option Bool := if valid then some enabled else none

theorem invalid_security_flag_is_refused (enabled : Bool) :
    securityFlag false enabled = none := by
  rfl

def plaintextAllowed (identity trust server auth tlsFirst nondefaultMinimum : Bool) : Bool :=
  !identity && !trust && !server && !auth && !tlsFirst && !nondefaultMinimum

theorem plaintext_trust_is_refused (identity server auth tlsFirst minimum : Bool) :
    plaintextAllowed identity true server auth tlsFirst minimum = false := by
  simp [plaintextAllowed]

theorem plaintext_server_is_refused (identity trust auth tlsFirst minimum : Bool) :
    plaintextAllowed identity trust true auth tlsFirst minimum = false := by
  simp [plaintextAllowed]

theorem plaintext_nondefault_minimum_is_refused (identity trust server auth tlsFirst : Bool) :
    plaintextAllowed identity trust server auth tlsFirst true = false := by
  simp [plaintextAllowed]

private def bit (value : Bool) : String := if value then "1" else "0"

def sourceVectors : IO Unit := do
  for fresh in [false, true] do
    for present in [false, true] do
      for spiffeKind in [false, true] do
        for matchingProfile in [false, true] do
          for matchingDomain in [false, true] do
            IO.println s!"source\t{bit fresh}\t{bit present}\t{bit spiffeKind}\t{bit matchingProfile}\t{bit matchingDomain}\t{bit (choose fresh present spiffeKind matchingProfile matchingDomain)}"

def clientSvidVectors : IO Unit := do
  for matchingId in [false, true] do
    for validProfile in [false, true] do
      IO.println s!"client-svid\t{bit matchingId}\t{bit validProfile}\t{bit (clientSvidAllowed matchingId validProfile)}"

def handshakeVectors : IO Unit := do
  for spent in [false, true] do
    IO.println s!"handshake-fence\t{bit spent}\t{bit (handshakeAllowed spent)}"

private def retryLabel (value : Option Nat) : String :=
  match value with
  | none => "none"
  | some n => toString n

def retryVectors : IO Unit := do
  for injected in [false, true] do
    for requested in [none, some 0, some 1, some 5] do
      IO.println s!"retry\t{bit injected}\t{retryLabel requested}\t{retryLabel (reconnectLimit injected requested)}"

def main : IO Unit := do
  match ← IO.getEnv "OPENSESAME_NATS_VECTOR_MODE" with
  | none => sourceVectors
  | some "source" => sourceVectors
  | some "client-svid" => clientSvidVectors
  | some "handshake-fence" => handshakeVectors
  | some "retry-limit" => retryVectors
  | some _ => throw <| IO.userError "unsupported NATS vector mode"

end OpenSesame.SourceTrustSelection

def main : IO Unit := OpenSesame.SourceTrustSelection.main
