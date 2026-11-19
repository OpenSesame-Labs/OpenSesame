import Lean

set_option autoImplicit false

namespace OpenSesame.PendingIntegrity

/-- Abstracts the unambiguous, domain-separated current MAC input. -/
structure CurrentMessage where
  encodedPayload : String
  verifierBinding : String
  deriving DecidableEq

def currentMessage (payload binding : String) : CurrentMessage := ⟨payload, binding⟩

theorem current_message_binds_payload (a b x y : String)
    (h : currentMessage a x = currentMessage b y) : a = b := by
  cases h
  rfl

theorem current_message_binds_verifier (a b x y : String)
    (h : currentMessage a x = currentMessage b y) : x = y := by
  cases h
  rfl

/-- Wire JSON may carry a plaintext verifier or a sealed `verifierEnc`; the MAC input always uses the scrypt-bound verifier. -/
inductive WireVerifier where
  | plaintext
  | sealed

def macUsesVerifierBinding (_wire : WireVerifier) : Bool :=
  true

theorem wire_encoding_does_not_change_mac_binding (a b : WireVerifier) :
    macUsesVerifierBinding a = macUsesVerifierBinding b := by
  rfl

/-- Legacy tags require a signed nonempty static-provider ID and no unsigned fields. -/
def acceptsLegacy (validTag hasProvider hasOrg hasByo hasUnknown : Bool) : Bool :=
  validTag && hasProvider && !hasOrg && !hasByo && !hasUnknown

theorem legacy_rejects_missing_provider (validTag hasOrg hasByo hasUnknown : Bool) :
    acceptsLegacy validTag false hasOrg hasByo hasUnknown = false := by
  simp [acceptsLegacy]

theorem legacy_rejects_organization (validTag hasProvider hasByo hasUnknown : Bool) :
    acceptsLegacy validTag hasProvider true hasByo hasUnknown = false := by
  simp [acceptsLegacy]

theorem legacy_rejects_byo (validTag hasProvider hasOrg hasUnknown : Bool) :
    acceptsLegacy validTag hasProvider hasOrg true hasUnknown = false := by
  simp [acceptsLegacy]

theorem legacy_rejects_unknown (validTag hasProvider hasOrg hasByo : Bool) :
    acceptsLegacy validTag hasProvider hasOrg hasByo true = false := by
  simp [acceptsLegacy]

theorem legacy_rejects_invalid_tag (hasProvider hasOrg hasByo hasUnknown : Bool) :
    acceptsLegacy false hasProvider hasOrg hasByo hasUnknown = false := by
  simp [acceptsLegacy]

/-- The issuing version placed a signed provider ID only on static flows. -/
inductive LegacyOrigin where
  | staticProvider
  | byo
  | organization

def issuedLegacyProvider : LegacyOrigin → Bool
  | .staticProvider => true
  | .byo => false
  | .organization => false

/-- Model stripping unsigned owner fields while the signed provider bit is bound. -/
def acceptsAfterOwnerStripped
    (origin : LegacyOrigin) (validTag signedProvider : Bool) : Bool :=
  (signedProvider == issuedLegacyProvider origin) &&
    acceptsLegacy validTag signedProvider false false false

theorem legacy_byo_strip_rejected (validTag signedProvider : Bool) :
    acceptsAfterOwnerStripped .byo validTag signedProvider = false := by
  cases signedProvider <;> simp [acceptsAfterOwnerStripped, issuedLegacyProvider, acceptsLegacy]

theorem legacy_organization_strip_rejected (validTag signedProvider : Bool) :
    acceptsAfterOwnerStripped .organization validTag signedProvider = false := by
  cases signedProvider <;> simp [acceptsAfterOwnerStripped, issuedLegacyProvider, acceptsLegacy]

theorem legacy_static_signed_provider_accepted :
    acceptsAfterOwnerStripped .staticProvider true true = true := by
  decide

/-- A supplied provenance ID must match both the current source and ID. -/
def fieldMatches (field : Option Nat) (source expected : Nat) : Bool :=
  match field with
  | none => true
  | some id => source == expected && id == 1

def fieldsMatch (provider byo org : Option Nat) (source : Nat) : Bool :=
  fieldMatches provider source 0 && fieldMatches byo source 1 &&
    fieldMatches org source 2

def acceptsProvenance (provider byo org : Option Nat) (source : Nat) : Bool :=
  fieldsMatch provider byo org source &&
    (provider.isSome || byo.isSome || org.isSome || source == 0)

theorem missing_provenance_only_static (source : Nat)
    (h : acceptsProvenance none none none source = true) : source = 0 := by
  simpa [acceptsProvenance, fieldsMatch, fieldMatches] using h

theorem accepted_organization_matches (provider byo : Option Nat) (source id : Nat)
    (h : acceptsProvenance provider byo (some id) source = true) :
    source = 2 ∧ id = 1 := by
  simp only [acceptsProvenance, Bool.and_eq_true] at h
  have fields := h.1
  simp [fieldsMatch, fieldMatches] at fields
  exact ⟨fields.2.1, fields.2.2⟩

theorem accepted_byo_matches (provider org : Option Nat) (source id : Nat)
    (h : acceptsProvenance provider (some id) org source = true) :
    source = 1 ∧ id = 1 := by
  simp only [acceptsProvenance, Bool.and_eq_true] at h
  have fields := h.1
  simp [fieldsMatch, fieldMatches] at fields
  exact fields.1.2

theorem accepted_provider_matches (byo org : Option Nat) (source id : Nat)
    (h : acceptsProvenance (some id) byo org source = true) :
    source = 0 ∧ id = 1 := by
  simp only [acceptsProvenance, Bool.and_eq_true] at h
  have fields := h.1
  simp [fieldsMatch, fieldMatches] at fields
  exact fields.1.1

private def bit (value : Bool) : String := if value then "1" else "0"
private def field (value : Option Nat) : String :=
  match value with
  | none => "-"
  | some id => toString id

def main : IO Unit := do
  for validTag in [false, true] do
    for hasProvider in [false, true] do
      for hasOrg in [false, true] do
        for hasByo in [false, true] do
          for hasUnknown in [false, true] do
            IO.println s!"legacy\t{bit validTag}\t{bit hasProvider}\t{bit hasOrg}\t{bit hasByo}\t{bit hasUnknown}\t{bit (acceptsLegacy validTag hasProvider hasOrg hasByo hasUnknown)}"
  for source in [0, 1, 2] do
    for provider in [none, some 1, some 2] do
      for byo in [none, some 1, some 2] do
        for org in [none, some 1, some 2] do
          IO.println s!"provenance\t{source}\t{field provider}\t{field byo}\t{field org}\t{bit (acceptsProvenance provider byo org source)}"

end OpenSesame.PendingIntegrity

def main : IO Unit := OpenSesame.PendingIntegrity.main
