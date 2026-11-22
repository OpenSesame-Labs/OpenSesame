/- Independently maintained required theorem types. Review each change against the documented requirement. -/
open OpenSesame.PendingIntegrity

#require_theorem OpenSesame.PendingIntegrity.current_message_binds_payload :
    ∀ (a b x y : String)
    (_h : currentMessage a x = currentMessage b y),
    a = b

#require_theorem OpenSesame.PendingIntegrity.current_message_binds_verifier :
    ∀ (a b x y : String)
    (_h : currentMessage a x = currentMessage b y),
    x = y

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

#require_theorem OpenSesame.PendingIntegrity.legacy_static_signed_provider_accepted :
    acceptsAfterOwnerStripped .staticProvider true true = true

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
