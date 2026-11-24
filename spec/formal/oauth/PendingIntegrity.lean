import Lean

set_option autoImplicit false

namespace OpenSesame.PendingIntegrity

/-! ## FED-I1: the v4 MAC input binds the payload and its sealed verifier

`federated-pending.ts` (`pendingMac`) tags `MAC_DOMAIN ‖ payload`, where
`payload` is the exact base64url JSON of the signed wire shape
(`sealedWireSchema`): the leg's issuer, state, nonce, optional kind, provider,
bring-your-own and organization IDs, and the AES-GCM-sealed `verifierEnc`.
The structure below abstracts that encoding as unambiguous; that the actual
JSON/base64url encoding is injective and that HMAC-SHA-256 is unforgeable are
assumptions, not proved here. -/

/-- The fields of the strict signed v4 wire shape. -/
structure SealedPayload where
  issuer : String
  state : String
  nonce : String
  kind : Option String
  providerId : Option String
  byoId : Option String
  orgId : Option String
  verifierEnc : String
  deriving DecidableEq

/-- Abstracts the domain-separated v4 MAC input `MAC_DOMAIN ‖ payload`. -/
structure CurrentMessage where
  domain : String
  encodedPayload : SealedPayload
  deriving DecidableEq

def macDomain : String := "OpenSesame:federated-pending:v4"

def currentMessage (payload : SealedPayload) : CurrentMessage := ⟨macDomain, payload⟩

theorem current_message_binds_payload (a b : SealedPayload)
    (h : currentMessage a = currentMessage b) : a = b := by
  cases h
  rfl

theorem current_message_binds_verifier (a b : SealedPayload)
    (h : currentMessage a = currentMessage b) : a.verifierEnc = b.verifierEnc := by
  cases h
  rfl

/-! ## FED-I4: the v4 decoder authenticates before any other work

`decodeSigned` (federated-pending.ts) runs, in order: the 4096-byte length
cap, the last-dot split and base64url shape check (cheap string checks, not
recorded as steps), the HMAC comparison (`mac`), the strict wire parse
(`parse`), the per-leg HKDF key derivation through the `PendingCookieKeys`
seam (`deriveKey`, which throws when the state or nonce exceeds 255 bytes),
and AES-GCM unsealing (`unseal`). `slowHash` names a password hash such as
the scrypt the retired v3 decoder ran; the v4 codec has none. -/

/-- The wire JSON shapes the decoder can meet after a valid tag. -/
inductive Wire where
  /-- Exactly the strict sealed shape: `verifierEnc`, no plaintext verifier. -/
  | sealed
  /-- A plaintext `verifier` (every legacy and unsigned shape). -/
  | plaintext
  /-- Both `verifier` and `verifierEnc`. -/
  | mixed
  /-- The sealed shape plus a field the strict schema does not declare. -/
  | unknownField
  /-- Not base64url JSON at all. -/
  | malformed
  deriving DecidableEq, Repr

/-- The abstract facts about one signed cookie that decide its decode path. -/
structure Cookie where
  oversize : Bool
  shapeOk : Bool
  tagValid : Bool
  wire : Wire
  legOk : Bool
  sealOk : Bool
  deriving DecidableEq, Repr

inductive Step where
  | mac
  | parse
  | deriveKey
  | unseal
  | slowHash
  deriving DecidableEq, Repr

/-- The work `decodeSigned` performs, in order. -/
def decodeTrace (c : Cookie) : List Step :=
  if c.oversize || !c.shapeOk then []
  else
    .mac :: (if !c.tagValid then []
      else .parse :: (if c.wire != .sealed then []
        else .deriveKey :: (if !c.legOk then [] else [.unseal])))

/-- Whether `decodeSigned` returns a pending leg. -/
def decodeAccepts (c : Cookie) : Bool :=
  !c.oversize && c.shapeOk && c.tagValid && c.wire == .sealed && c.legOk && c.sealOk

/-- Key derivations observed through the `PendingCookieKeys` seam. -/
def derivations (c : Cookie) : Nat := (decodeTrace c).count .deriveKey

theorem mac_first (c : Cookie) :
    decodeTrace c = [] ∨ ∃ rest, decodeTrace c = .mac :: rest ∧ .mac ∉ rest := by
  rcases c with ⟨oversize, shapeOk, tagValid, wire, legOk, sealOk⟩
  cases oversize <;> cases shapeOk <;> cases tagValid <;> cases wire <;>
    cases legOk <;> simp [decodeTrace]

theorem invalid_tag_no_work (c : Cookie) (h : c.tagValid = false) :
    ∀ s ∈ decodeTrace c, s = .mac := by
  rcases c with ⟨oversize, shapeOk, tagValid, wire, legOk, sealOk⟩
  simp only at h
  subst h
  cases oversize <;> cases shapeOk <;> simp [decodeTrace]

theorem accepted_requires_valid_tag (c : Cookie) (h : decodeAccepts c = true) :
    c.tagValid = true := by
  rcases c with ⟨oversize, shapeOk, tagValid, wire, legOk, sealOk⟩
  revert h
  cases oversize <;> cases shapeOk <;> cases tagValid <;> cases wire <;>
    cases legOk <;> cases sealOk <;> decide

theorem accepted_requires_sealed_only (c : Cookie) (h : decodeAccepts c = true) :
    c.wire = .sealed := by
  rcases c with ⟨oversize, shapeOk, tagValid, wire, legOk, sealOk⟩
  revert h
  cases oversize <;> cases shapeOk <;> cases tagValid <;> cases wire <;>
    cases legOk <;> cases sealOk <;> decide

theorem accepted_derives_once (c : Cookie) (h : decodeAccepts c = true) :
    derivations c = 1 := by
  rcases c with ⟨oversize, shapeOk, tagValid, wire, legOk, sealOk⟩
  revert h
  cases oversize <;> cases shapeOk <;> cases tagValid <;> cases wire <;>
    cases legOk <;> cases sealOk <;> decide

theorem derivations_at_most_one (c : Cookie) : derivations c ≤ 1 := by
  rcases c with ⟨oversize, shapeOk, tagValid, wire, legOk, sealOk⟩
  cases oversize <;> cases shapeOk <;> cases tagValid <;> cases wire <;>
    cases legOk <;> cases sealOk <;> decide

theorem no_slow_hash (c : Cookie) : Step.slowHash ∉ decodeTrace c := by
  rcases c with ⟨oversize, shapeOk, tagValid, wire, legOk, sealOk⟩
  cases oversize <;> cases shapeOk <;> cases tagValid <;> cases wire <;>
    cases legOk <;> simp [decodeTrace]

/-- The retired v3 decoder, for contrast: it ran scrypt over the cookie's
verifier to rebuild the MAC input before it could compare the tag. -/
def decodeTraceV3 (c : Cookie) : List Step :=
  if c.oversize || !c.shapeOk then [] else [.parse, .slowHash, .mac]

theorem v3_slow_hash_before_mac :
    ∃ c : Cookie, c.tagValid = false ∧ decodeTraceV3 c = [.parse, .slowHash, .mac] :=
  ⟨⟨false, true, false, .plaintext, true, true⟩, rfl, rfl⟩

/-! ## FED-I2: every legacy cookie is refused

Legacy (pre-v3) payloads carry a plaintext `verifier`, so under the v4
decoder they meet the strict sealed schema as `Wire.plaintext` and are
refused even if their tag were valid. (Their tag is HMAC over a different
message and key, so it is invalid unless HMAC is forged.) The provenance
arguments are kept so the earlier refusal obligations still read as stated;
v4 refuses regardless of them. -/

def legacyAsV4 (validTag : Bool) : Cookie :=
  ⟨false, true, validTag, .plaintext, true, true⟩

def acceptsLegacy (validTag _hasProvider _hasOrg _hasByo _hasUnknown : Bool) : Bool :=
  decodeAccepts (legacyAsV4 validTag)

theorem legacy_never_accepted (validTag hasProvider hasOrg hasByo hasUnknown : Bool) :
    acceptsLegacy validTag hasProvider hasOrg hasByo hasUnknown = false := by
  cases validTag <;> rfl

theorem legacy_rejects_missing_provider (validTag hasOrg hasByo hasUnknown : Bool) :
    acceptsLegacy validTag false hasOrg hasByo hasUnknown = false :=
  legacy_never_accepted validTag false hasOrg hasByo hasUnknown

theorem legacy_rejects_organization (validTag hasProvider hasByo hasUnknown : Bool) :
    acceptsLegacy validTag hasProvider true hasByo hasUnknown = false :=
  legacy_never_accepted validTag hasProvider true hasByo hasUnknown

theorem legacy_rejects_byo (validTag hasProvider hasOrg hasUnknown : Bool) :
    acceptsLegacy validTag hasProvider hasOrg true hasUnknown = false :=
  legacy_never_accepted validTag hasProvider hasOrg true hasUnknown

theorem legacy_rejects_unknown (validTag hasProvider hasOrg hasByo : Bool) :
    acceptsLegacy validTag hasProvider hasOrg hasByo true = false :=
  legacy_never_accepted validTag hasProvider hasOrg hasByo true

theorem legacy_rejects_invalid_tag (hasProvider hasOrg hasByo hasUnknown : Bool) :
    acceptsLegacy false hasProvider hasOrg hasByo hasUnknown = false :=
  legacy_never_accepted false hasProvider hasOrg hasByo hasUnknown

/-- The issuing version placed a signed provider ID only on static flows. -/
inductive LegacyOrigin where
  | staticProvider
  | byo
  | organization

def issuedLegacyProvider : LegacyOrigin → Bool
  | .staticProvider => true
  | .byo => false
  | .organization => false

/-- A legacy cookie whose unsigned owner fields were stripped in transit. -/
def acceptsAfterOwnerStripped
    (origin : LegacyOrigin) (validTag signedProvider : Bool) : Bool :=
  (signedProvider == issuedLegacyProvider origin) &&
    acceptsLegacy validTag signedProvider false false false

theorem legacy_byo_strip_rejected (validTag signedProvider : Bool) :
    acceptsAfterOwnerStripped .byo validTag signedProvider = false := by
  cases validTag <;> cases signedProvider <;> decide

theorem legacy_organization_strip_rejected (validTag signedProvider : Bool) :
    acceptsAfterOwnerStripped .organization validTag signedProvider = false := by
  cases validTag <;> cases signedProvider <;> decide

theorem legacy_static_signed_provider_refused :
    acceptsAfterOwnerStripped .staticProvider true true = false := by
  decide

/-! ## FED-I3: current trust must match supplied provenance -/

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
private def wireName : Wire → String
  | .sealed => "sealed"
  | .plaintext => "plaintext"
  | .mixed => "mixed"
  | .unknownField => "unknown"
  | .malformed => "malformed"

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
  for oversize in [false, true] do
    for shapeOk in [false, true] do
      for tagValid in [false, true] do
        for wire in [Wire.sealed, .plaintext, .mixed, .unknownField, .malformed] do
          for legOk in [false, true] do
            for sealOk in [false, true] do
              let c : Cookie := ⟨oversize, shapeOk, tagValid, wire, legOk, sealOk⟩
              IO.println s!"v4\t{bit oversize}\t{bit shapeOk}\t{bit tagValid}\t{wireName wire}\t{bit legOk}\t{bit sealOk}\t{derivations c}\t{bit (decodeAccepts c)}"

end OpenSesame.PendingIntegrity

def main : IO Unit := OpenSesame.PendingIntegrity.main
