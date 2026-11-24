import Lean

set_option autoImplicit false

namespace OpenSesame.AuthPolicy

inductive Assurance where
  | provisional | selfAsserted | verified | mfa | phishingResistant
  | enterpriseManaged | workloadAttested
  deriving DecidableEq, Repr

inductive PrincipalVerdict where
  | notFound | provisional | admitted
  deriving DecidableEq, Repr

def principalVerdict : Option Assurance → PrincipalVerdict
  | none => .notFound
  | some .provisional => .provisional
  | some _ => .admitted

theorem missing_principal_denied : principalVerdict none = .notFound := rfl

theorem provisional_principal_denied :
    principalVerdict (some .provisional) = .provisional := rfl

theorem admitted_principal_not_provisional (a : Assurance)
    (h : principalVerdict (some a) = .admitted) : a ≠ .provisional := by
  cases a <;> simp_all [principalVerdict]

inductive SessionPrincipal where
  | missing | provisional | active | suspended | closed
  deriving DecidableEq, Repr

def principalCanAuthenticate : SessionPrincipal → Bool
  | .provisional | .active => true
  | _ => false

def sessionAdmitted (hasPrefix mapped present unrevoked : Bool)
    (expiresAt now : Int) (principal : SessionPrincipal) : Bool :=
  hasPrefix && mapped && present && decide (now < expiresAt) && unrevoked &&
    principalCanAuthenticate principal

theorem bad_session_prefix_denied (mapped present unrevoked : Bool)
    (expiresAt now : Int) (principal : SessionPrincipal) :
    sessionAdmitted false mapped present unrevoked expiresAt now principal = false := by
  simp [sessionAdmitted]

theorem unmapped_session_denied (hasPrefix present unrevoked : Bool)
    (expiresAt now : Int) (principal : SessionPrincipal) :
    sessionAdmitted hasPrefix false present unrevoked expiresAt now principal = false := by
  simp [sessionAdmitted]

theorem missing_session_denied (hasPrefix mapped unrevoked : Bool)
    (expiresAt now : Int) (principal : SessionPrincipal) :
    sessionAdmitted hasPrefix mapped false unrevoked expiresAt now principal = false := by
  simp [sessionAdmitted]

theorem revoked_session_denied (hasPrefix mapped present : Bool)
    (expiresAt now : Int) (principal : SessionPrincipal) :
    sessionAdmitted hasPrefix mapped present false expiresAt now principal = false := by
  simp [sessionAdmitted]

theorem expired_session_denied (hasPrefix mapped present unrevoked : Bool)
    (expiresAt now : Int) (principal : SessionPrincipal) (h : expiresAt ≤ now) :
    sessionAdmitted hasPrefix mapped present unrevoked expiresAt now principal = false := by
  simp [sessionAdmitted, Int.not_lt.mpr h]

theorem closed_principal_session_denied (hasPrefix mapped present unrevoked : Bool)
    (expiresAt now : Int) :
    sessionAdmitted hasPrefix mapped present unrevoked expiresAt now .closed = false := by
  simp [sessionAdmitted, principalCanAuthenticate]

theorem suspended_principal_session_denied (hasPrefix mapped present unrevoked : Bool)
    (expiresAt now : Int) :
    sessionAdmitted hasPrefix mapped present unrevoked expiresAt now .suspended = false := by
  simp [sessionAdmitted, principalCanAuthenticate]

theorem missing_principal_session_denied (hasPrefix mapped present unrevoked : Bool)
    (expiresAt now : Int) :
    sessionAdmitted hasPrefix mapped present unrevoked expiresAt now .missing = false := by
  simp [sessionAdmitted, principalCanAuthenticate]

inductive Role where
  | member | admin | owner
  deriving DecidableEq, Repr

inductive ProjectState where
  | provisional | active | expired | deleting | deleted
  deriving DecidableEq, Repr

def isVisible (state : ProjectState) (expiresAt : Option Int) (now : Int) : Bool :=
  match state with
  | .provisional | .active =>
    match expiresAt with
    | none => true
    | some expires => decide (now < expires)
  | _ => false

theorem not_visible_at_expiry (state : ProjectState) (now : Int) :
    isVisible state (some now) now = false := by
  cases state <;> simp [isVisible]

theorem not_visible_after_expiry (state : ProjectState) (expiresAt now : Int)
    (h : expiresAt ≤ now) : isVisible state (some expiresAt) now = false := by
  cases state <;> simp [isVisible, Int.not_lt.mpr h]

theorem deleted_project_not_visible (expiresAt : Option Int) (now : Int) :
    isVisible .deleted expiresAt now = false := rfl

structure Proofs where
  member : Bool
  admin : Bool
  owner : Bool
  deriving DecidableEq, Repr

def projectDecision (present visible : Bool) (role : Option Role) : Option Role :=
  if present && visible then role else none

def proofsFor : Option Role → Proofs
  | none => ⟨false, false, false⟩
  | some .member => ⟨true, false, false⟩
  | some .admin => ⟨true, true, false⟩
  | some .owner => ⟨true, true, true⟩

theorem hidden_project_denied (present : Bool) (role : Option Role) :
    projectDecision present false role = none := by
  cases present <;> rfl

theorem absent_project_denied (visible : Bool) (role : Option Role) :
    projectDecision false visible role = none := rfl

theorem no_role_denied (present visible : Bool) :
    projectDecision present visible none = none := by
  cases present <;> cases visible <;> rfl

theorem member_never_receives_admin (present visible : Bool) :
    (proofsFor (projectDecision present visible (some .member))).admin = false := by
  cases present <;> cases visible <;> rfl

theorem nonowner_never_receives_owner (present visible : Bool) (role : Option Role)
    (h : role ≠ some .owner) :
    (proofsFor (projectDecision present visible role)).owner = false := by
  cases present <;> cases visible <;> cases role with
  | none => all_goals simp [projectDecision, proofsFor]
  | some r => cases r <;> simp_all [projectDecision, proofsFor]

private def assuranceCases : List (String × Option Assurance) := [
  ("missing", none), ("provisional", some .provisional),
  ("self_asserted", some .selfAsserted), ("verified", some .verified),
  ("mfa", some .mfa), ("phishing_resistant", some .phishingResistant),
  ("enterprise_managed", some .enterpriseManaged),
  ("workload_attested", some .workloadAttested)]

private def principalLabel : PrincipalVerdict → String
  | .notFound => "not_found"
  | .provisional => "provisional"
  | .admitted => "admitted"

private def roleCases : List (String × Option Role) := [
  ("none", none), ("member", some .member), ("admin", some .admin),
  ("owner", some .owner)]

private def stateCases : List (String × ProjectState) := [
  ("provisional", .provisional), ("active", .active), ("expired", .expired),
  ("deleting", .deleting), ("deleted", .deleted)]

private def expiryCases : List (String × Option Int) := [
  ("none", none), ("past", some (-1)), ("equal", some 0),
  ("future", some 1)]

private def sessionExpiryCases : List (String × Int) := [
  ("past", -1), ("equal", 0), ("future", 1)]

private def sessionPrincipalCases : List (String × SessionPrincipal) := [
  ("missing", .missing), ("provisional", .provisional), ("active", .active),
  ("suspended", .suspended), ("closed", .closed)]

private def roleLabel : Option Role → String
  | none => "denied"
  | some .member => "member"
  | some .admin => "admin"
  | some .owner => "owner"

private def bit (b : Bool) : String := if b then "1" else "0"

def main : IO Unit := do
  for (label, assurance) in assuranceCases do
    IO.println s!"principal\t{label}\t{principalLabel (principalVerdict assurance)}"
  for hasPrefix in [false, true] do
    for mapped in [false, true] do
      for present in [false, true] do
        for (expiryLabel, expiry) in sessionExpiryCases do
          for unrevoked in [false, true] do
            for (label, principal) in sessionPrincipalCases do
              let admitted := sessionAdmitted hasPrefix mapped present unrevoked expiry 0 principal
              IO.println s!"session\t{bit hasPrefix}\t{bit mapped}\t{bit present}\t{expiryLabel}\t{bit unrevoked}\t{label}\t{bit admitted}"
  for present in [false, true] do
    for (stateLabel, state) in stateCases do
      for (expiryLabel, expiry) in expiryCases do
        for (label, role) in roleCases do
          let decision := projectDecision present (isVisible state expiry 0) role
          let proofs := proofsFor decision
          IO.println s!"project\t{bit present}\t{stateLabel}\t{expiryLabel}\t{label}\t{roleLabel decision}\t{bit proofs.member}\t{bit proofs.admin}\t{bit proofs.owner}"

end OpenSesame.AuthPolicy

namespace OpenSesame.AuthPolicy.Storage

/-! AUTH-S1 storage contract: `DurableMap` (repos/durable-map.ts) with `secretKeys`.
A row id is only an `oidcLookup` (keyed HMAC) of the key (`keyed`) or, before
2026-11-23, of its SHA-256 digest (`legacyDigest`, durable-map-legacy.ts).
`legacy = true`: reads also address the legacy id (before #2927);
`false`: requests address only the keyed id (#2927). Sealing, capacity, the purge of expired
rows, concurrency and the database are outside the model. -/

inductive RowId where | keyed (key : String) | legacyDigest (key : String)
  deriving DecidableEq

structure Row (V : Type) where (value : V) (expiresAt : Option Int)

def Row.live {V : Type} (now : Int) (r : Row V) : Bool :=
  match r.expiresAt with | none => true | some t => decide (now < t)

abbrev Store (V : Type) := RowId → Option (Row V)

/-- The ids a key-addressed operation reads or deletes (`DurableMap.ids`). -/
def addresses (legacy : Bool) (key : String) : List RowId :=
  if legacy then [.keyed key, .legacyDigest key] else [.keyed key]

def liveAt {V : Type} (s : Store V) (now : Int) (id : RowId) : Option (Row V) :=
  match s id with | some r => if r.live now then some r else none | none => none

/-- `get`: live rows under the key's addresses, the keyed id preferred. -/
def lookup {V : Type} (legacy : Bool) (s : Store V) (now : Int) (key : String) : Option V :=
  match liveAt s now (.keyed key) with
  | some r => some r.value
  | none => if legacy then (liveAt s now (.legacyDigest key)).map (·.value) else none

def put {V : Type} (s : Store V) (id : RowId) (v : Option (Row V)) : Store V :=
  fun j => if j = id then v else s j

/-- `write`: delete the key's rows under every address, store the new row at the keyed id. -/
def write {V : Type} (s : Store V) (key : String) (r : Row V) : Store V :=
  put (put s (.legacyDigest key) none) (.keyed key) (some r)

/-- `rekey` (`adoptLegacyRow`): copy the legacy row unless the keyed id holds a
row live at `now`, then delete the legacy row, in one transaction. -/
def rekey {V : Type} (s : Store V) (now : Int) (key : String) : Store V :=
  match s (.legacyDigest key) with
  | none => s
  | some r =>
    put (match liveAt s now (.keyed key) with
      | some _ => s
      | none => put s (.keyed key) (some r)) (.legacyDigest key) none

/-- Startup re-keying of recoverable keys (`rekeyRecoverable`, `rekeyKeys`). -/
def migrate {V : Type} (s : Store V) (now : Int) (keys : List String) : Store V :=
  keys.foldl (fun t k => rekey t now k) s

theorem lookup_reads_only_addresses {V : Type} (legacy : Bool) (s t : Store V)
    (now : Int) (key : String) (h : ∀ id ∈ addresses legacy key, s id = t id) :
    lookup legacy s now key = lookup legacy t now key := by
  cases legacy <;> simp [addresses] at h <;> simp [lookup, liveAt, h]

theorem legacy_free_addresses_keyed_only (key : String) :
    ∀ id ∈ addresses false key, id = .keyed key := by simp [addresses]

theorem write_stores_only_keyed {V : Type} (s : Store V) (key : String) (r : Row V) :
    (write s key r (.keyed key)).isSome ∧ write s key r (.legacyDigest key) = none ∧
      ∀ id, id ∉ addresses true key → write s key r id = s id := by
  refine ⟨by simp [write, put], by simp [write, put], ?_⟩
  intro id hid
  simp [addresses] at hid
  simp [write, put, hid.1, hid.2]

theorem write_then_lookup {V : Type} (legacy : Bool) (s : Store V) (key : String)
    (r : Row V) (now : Int) (h : r.live now = true) :
    lookup legacy (write s key r) now key = some r.value := by simp [lookup, liveAt, write, put, h]

theorem rekey_other_ids {V : Type} (s : Store V) (now : Int) (key : String) (id : RowId)
    (h : id ∉ addresses true key) : rekey s now key id = s id := by
  simp [addresses] at h
  cases hl : s (.legacyDigest key) <;> cases hk : liveAt s now (.keyed key) <;>
    simp [rekey, hl, hk, put, h.1, h.2]

theorem rekey_keeps_keyed {V : Type} (s : Store V) (now : Int) (key : String) (c : Row V)
    (h : s (.keyed key) = some c) (hl : c.live now = true) :
    rekey s now key (.keyed key) = some c := by
  have hk : liveAt s now (.keyed key) = some c := by simp [liveAt, h, hl]
  cases hg : s (.legacyDigest key) <;> simp [rekey, hg, hk, h, put]

theorem rekey_preserves_lookup {V : Type} (s : Store V) (now : Int) (key : String) :
    lookup true (rekey s now key) now key = lookup true s now key := by
  cases hl : s (.legacyDigest key) with
  | none => simp [rekey, hl]
  | some r =>
    cases hk : liveAt s now (.keyed key) with
    | none =>
      have hb : lookup true s now key = (liveAt s now (.legacyDigest key)).map (·.value) := by
        simp [lookup, hk]
      have hs : rekey s now key = put (put s (.keyed key) (some r)) (.legacyDigest key) none := by
        simp only [rekey, hl, hk]
      rw [hs, hb]
      simp [lookup, liveAt, put, hl]
      cases r.live now <;> rfl
    | some c =>
      have hs : rekey s now key = put s (.legacyDigest key) none := by simp only [rekey, hl, hk]
      have ha : liveAt (rekey s now key) now (.keyed key) = some c := by
        rw [hs, ← hk]; simp [liveAt, put]
      simp [lookup, ha, hk]

private def NoExpiryKeyed {V : Type} (s : Store V) (key : String) : Prop :=
  ∃ c, s (.keyed key) = some c ∧ c.expiresAt = none

private def NoExpiryPending {V : Type} (s : Store V) (now : Int) (key : String) : Prop :=
  NoExpiryKeyed s key ∨ (liveAt s now (.keyed key) = none ∧
    ∃ r, s (.legacyDigest key) = some r ∧ r.expiresAt = none)

private theorem rekey_keeps_noExpiryKeyed {V : Type} (s : Store V) (now : Int)
    (key k : String) (h : NoExpiryKeyed s key) : NoExpiryKeyed (rekey s now k) key := by
  obtain ⟨c, hc, he⟩ := h
  refine ⟨c, ?_, he⟩
  by_cases hk : k = key
  · subst hk; exact rekey_keeps_keyed s now k c hc (by simp [Row.live, he])
  · rw [rekey_other_ids s now k (.keyed key) (by simp [addresses]; exact fun h => hk h.symm)]
    exact hc

private theorem rekey_settles {V : Type} (s : Store V) (now : Int) (key : String)
    (h : NoExpiryPending s now key) : NoExpiryKeyed (rekey s now key) key := by
  rcases h with h | ⟨hk, r, hl, he⟩
  · exact rekey_keeps_noExpiryKeyed s now key key h
  · exact ⟨r, by simp [rekey, hl, hk, put], he⟩

private theorem rekey_keeps_pending {V : Type} (s : Store V) (now : Int) (key k : String)
    (hne : k ≠ key) (h : NoExpiryPending s now key) :
    NoExpiryPending (rekey s now k) now key := by
  have hkid : RowId.keyed key ∉ addresses true k := by
    simp [addresses]; exact fun h => hne h.symm
  have hlid : RowId.legacyDigest key ∉ addresses true k := by
    simp [addresses]; exact fun h => hne h.symm
  rcases h with h | ⟨hk, r, hl, he⟩
  · exact Or.inl (rekey_keeps_noExpiryKeyed s now key k h)
  · refine Or.inr ⟨?_, r, by rw [rekey_other_ids s now k _ hlid]; exact hl, he⟩
    unfold liveAt at hk ⊢
    rw [rekey_other_ids s now k _ hkid]
    exact hk

private theorem migrate_keeps_noExpiryKeyed {V : Type} (now : Int) (keys : List String)
    (key : String) : ∀ s : Store V, NoExpiryKeyed s key → NoExpiryKeyed (migrate s now keys) key := by
  induction keys with
  | nil => intro s h; exact h
  | cons k rest ih => intro s h; exact ih (rekey s now k) (rekey_keeps_noExpiryKeyed s now key k h)

private theorem migrate_settles {V : Type} (now : Int) (keys : List String) (key : String)
    (hmem : key ∈ keys) : ∀ s : Store V, NoExpiryPending s now key →
      NoExpiryKeyed (migrate s now keys) key := by
  induction keys with
  | nil => cases hmem
  | cons k rest ih =>
    intro s h
    by_cases hk : k = key
    · subst hk
      exact migrate_keeps_noExpiryKeyed now rest k (rekey s now k) (rekey_settles s now k h)
    · have hrest : key ∈ rest := by
        rcases List.mem_cons.mp hmem with h' | h'
        · exact absurd h'.symm hk
        · exact h'
      exact ih hrest (rekey s now k) (rekey_keeps_pending s now key k hk h)

/-- A no-expiry legacy row whose key the migration at `now` recovers is findable
by the keyed id alone at every later time, unless that id already held a live
row with an expiry (the newer value then wins). -/
theorem migration_keeps_no_expiry_rows {V : Type} (s : Store V) (now : Int)
    (keys : List String) (key : String) (r : Row V) (hl : s (.legacyDigest key) = some r)
    (he : r.expiresAt = none)
    (hk : liveAt s now (.keyed key) = none ∨ ∃ c, s (.keyed key) = some c ∧ c.expiresAt = none)
    (hmem : key ∈ keys) (later : Int) :
    (lookup false (migrate s now keys) later key).isSome = true := by
  have hp : NoExpiryPending s now key := by
    rcases hk with hk | hk
    · exact Or.inr ⟨hk, r, hl, he⟩
    · exact Or.inl hk
  obtain ⟨c, hc, hce⟩ := migrate_settles now keys key hmem s hp
  simp [lookup, liveAt, hc, Row.live, hce]

/-- Without the fallback, a key held only by its legacy id (a pre-upgrade bearer) is refused. -/
theorem legacy_only_row_refused {V : Type} (s : Store V) (now : Int) (key : String)
    (h : s (.keyed key) = none) : lookup false s now key = none := by simp [lookup, liveAt, h]

/-- Contract (2): startup serves only once no legacy row remains, and then
removing the fallback changes no read. -/
theorem served_store_needs_no_fallback {V : Type} (s : Store V) (now : Int) (key : String)
    (h : ∀ k, s (.legacyDigest k) = none) : lookup false s now key = lookup true s now key := by
  cases hk : liveAt s now (.keyed key) <;> simp_all [lookup, liveAt]

end OpenSesame.AuthPolicy.Storage
-- `lean --run` needs an unqualified entrypoint.
def main : IO Unit := OpenSesame.AuthPolicy.main
