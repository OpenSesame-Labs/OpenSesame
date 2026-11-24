/- Independently maintained required theorem types. Review each change against the documented requirement. -/
open OpenSesame.PendingIntegrity

#require_theorem OpenSesame.PendingIntegrity.current_message_binds_payload :
    ∀ (a b : SealedPayload)
    (_h : currentMessage a = currentMessage b),
    a = b

#require_theorem OpenSesame.PendingIntegrity.current_message_binds_verifier :
    ∀ (a b : SealedPayload)
    (_h : currentMessage a = currentMessage b),
    a.verifierEnc = b.verifierEnc

#require_theorem OpenSesame.PendingIntegrity.mac_first :
    ∀ (c : Cookie),
    decodeTrace c = [] ∨ ∃ rest, decodeTrace c = Step.mac :: rest ∧ Step.mac ∉ rest

#require_theorem OpenSesame.PendingIntegrity.invalid_tag_no_work :
    ∀ (c : Cookie) (_h : c.tagValid = false),
    ∀ s ∈ decodeTrace c, s = Step.mac

#require_theorem OpenSesame.PendingIntegrity.accepted_requires_valid_tag :
    ∀ (c : Cookie) (_h : decodeAccepts c = true), c.tagValid = true

#require_theorem OpenSesame.PendingIntegrity.accepted_requires_sealed_only :
    ∀ (c : Cookie) (_h : decodeAccepts c = true), c.wire = Wire.sealed

#require_theorem OpenSesame.PendingIntegrity.accepted_derives_once :
    ∀ (c : Cookie) (_h : decodeAccepts c = true), derivations c = 1

#require_theorem OpenSesame.PendingIntegrity.derivations_at_most_one :
    ∀ (c : Cookie), derivations c ≤ 1

#require_theorem OpenSesame.PendingIntegrity.no_slow_hash :
    ∀ (c : Cookie), Step.slowHash ∉ decodeTrace c

#require_theorem OpenSesame.PendingIntegrity.legacy_never_accepted :
    ∀ (validTag hasProvider hasOrg hasByo hasUnknown : Bool),
    acceptsLegacy validTag hasProvider hasOrg hasByo hasUnknown = false

#require_theorem OpenSesame.PendingIntegrity.legacy_rejects_missing_provider :
    ∀ (validTag hasOrg hasByo hasUnknown : Bool),
    acceptsLegacy validTag false hasOrg hasByo hasUnknown = false

#require_theorem OpenSesame.PendingIntegrity.legacy_rejects_organization :
    ∀ (validTag hasProvider hasByo hasUnknown : Bool),
    acceptsLegacy validTag hasProvider true hasByo hasUnknown = false

#require_theorem OpenSesame.PendingIntegrity.legacy_rejects_byo :
    ∀ (validTag hasProvider hasOrg hasUnknown : Bool),
    acceptsLegacy validTag hasProvider hasOrg true hasUnknown = false

#require_theorem OpenSesame.PendingIntegrity.legacy_rejects_unknown :
    ∀ (validTag hasProvider hasOrg hasByo : Bool),
    acceptsLegacy validTag hasProvider hasOrg hasByo true = false

#require_theorem OpenSesame.PendingIntegrity.legacy_rejects_invalid_tag :
    ∀ (hasProvider hasOrg hasByo hasUnknown : Bool),
    acceptsLegacy false hasProvider hasOrg hasByo hasUnknown = false

#require_theorem OpenSesame.PendingIntegrity.legacy_byo_strip_rejected :
    ∀ (validTag signedProvider : Bool),
    acceptsAfterOwnerStripped .byo validTag signedProvider = false

#require_theorem OpenSesame.PendingIntegrity.legacy_organization_strip_rejected :
    ∀ (validTag signedProvider : Bool),
    acceptsAfterOwnerStripped .organization validTag signedProvider = false

#require_theorem OpenSesame.PendingIntegrity.legacy_static_signed_provider_refused :
    acceptsAfterOwnerStripped .staticProvider true true = false

#require_theorem OpenSesame.PendingIntegrity.missing_provenance_only_static :
    ∀ (source : Nat)
    (_h : acceptsProvenance none none none source = true), source = 0

#require_theorem OpenSesame.PendingIntegrity.accepted_organization_matches :
    ∀ (provider byo : Option Nat) (source id : Nat)
    (_h : acceptsProvenance provider byo (some id) source = true),
    source = 2 ∧ id = 1

#require_theorem OpenSesame.PendingIntegrity.accepted_byo_matches :
    ∀ (provider org : Option Nat) (source id : Nat)
    (_h : acceptsProvenance provider (some id) org source = true),
    source = 1 ∧ id = 1

#require_theorem OpenSesame.PendingIntegrity.accepted_provider_matches :
    ∀ (byo org : Option Nat) (source id : Nat)
    (_h : acceptsProvenance (some id) byo org source = true),
    source = 0 ∧ id = 1
