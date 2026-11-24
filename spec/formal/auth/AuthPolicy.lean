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

end OpenSesame.AuthPolicy

namespace OpenSesame.AuthPolicy.Storage

/-! AUTH-S1 storage: one `DurableMap` (repos/durable-map.ts) with `secretKeys`.
A row id is an `oidcLookup` (keyed HMAC) of the key (`keyed`, `id`, line 52) or,
before 2026-11-23, of its SHA-256 digest (`legacyDigest`, durable-map-legacy.ts
line 34). The two kinds are assumed disjoint: no key of a map is the SHA-256 hex
digest of another of its keys (`hasCurrentRowId`, line 111, leaves such a row).
`legacy = true` is the pre-#2927 read fallback; requests now read with `false`.
`now` is the database clock of one operation. Sealing, capacity, transactions,
concurrency, crash durability and the database engine are outside the model. -/
inductive RowId where | keyed (key : String) | legacyDigest (key : String)
  deriving DecidableEq
structure Row (V : Type) where (value : V) (expiresAt : Option Int)
/-- `live()` (line 61): no expiry, or an expiry after `now`. -/
def Row.live {V : Type} (now : Int) (r : Row V) : Bool :=
  match r.expiresAt with | none => true | some t => decide (now < t)
abbrev Store (V : Type) := RowId → Option (Row V)
/-- The ids a key-addressed operation reads or deletes. -/
def addresses (legacy : Bool) (key : String) : List RowId :=
  if legacy then [.keyed key, .legacyDigest key] else [.keyed key]
/-- The live row at an id; as a store, the purge `DELETE … expires_at <= now` (line 150). -/
def liveAt {V : Type} (s : Store V) (now : Int) (id : RowId) : Option (Row V) :=
  match s id with | some r => if r.live now then some r else none | none => none
/-- `get` (line 72): the live row under the key's addresses, the keyed id preferred. -/
def lookup {V : Type} (legacy : Bool) (s : Store V) (now : Int) (key : String) : Option V :=
  match liveAt s now (.keyed key) with
  | some r => some r.value
  | none => if legacy then (liveAt s now (.legacyDigest key)).map (·.value) else none
def put {V : Type} (s : Store V) (id : RowId) (v : Option (Row V)) : Store V :=
  fun j => if j = id then v else s j
/-- `set` (`write`, lines 137–175): purge expired rows, upsert at the keyed id. -/
def write {V : Type} (s : Store V) (now : Int) (key : String) (r : Row V) : Store V :=
  put (liveAt s now) (.keyed key) (some r)
/-- `claim`: as `write`, refused when the purged store holds the keyed id. -/
def claim {V : Type} (s : Store V) (now : Int) (key : String) (r : Row V) : Store V × Bool :=
  if (liveAt s now (.keyed key)).isSome then (liveAt s now, false) else (write s now key r, true)
/-- `delete` (lines 205–214): remove the keyed row, live or not. -/
def delete {V : Type} (s : Store V) (key : String) : Store V × Bool :=
  (put s (.keyed key) none, (s (.keyed key)).isSome)
/-- `take` (lines 227–236): remove and return the live keyed row. -/
def take {V : Type} (s : Store V) (now : Int) (key : String) : Store V × Option V :=
  match liveAt s now (.keyed key) with
  | some r => (put s (.keyed key) none, some r.value)
  | none => (s, none)
/-- `adoptLegacyRow` (lines 100–125): copy the legacy row unless the keyed id
holds a row live at `now`, then delete the legacy row, in one transaction. -/
def rekey {V : Type} (s : Store V) (now : Int) (key : String) : Store V :=
  match s (.legacyDigest key) with
  | none => s
  | some r =>
    put (match liveAt s now (.keyed key) with
      | some _ => s
      | none => put s (.keyed key) (some r)) (.legacyDigest key) none
/-- `rekeyKeys` and `rekeyRecoverable` adopt only rows `legacyRows()` lists: live ones. -/
def rekeyIfLive {V : Type} (s : Store V) (now : Int) (key : String) : Store V :=
  if (liveAt s now (.legacyDigest key)).isSome then rekey s now key else s
/-- Startup re-keying of the recovered keys (security-map-rekey.ts). -/
def migrate {V : Type} (s : Store V) (now : Int) (keys : List String) : Store V :=
  keys.foldl (fun t k => rekeyIfLive t now k) s

theorem lookup_reads_only_addresses {V : Type} (legacy : Bool) (s t : Store V)
    (now : Int) (key : String) (h : ∀ id ∈ addresses legacy key, s id = t id) :
    lookup legacy s now key = lookup legacy t now key := by
  cases legacy <;> simp [addresses] at h <;> simp [lookup, liveAt, h]

theorem legacy_free_addresses_keyed_only (key : String) :
    ∀ id ∈ addresses false key, id = .keyed key := by simp [addresses]

theorem write_stores_only_keyed {V : Type} (s : Store V) (now : Int) (key : String)
    (r : Row V) : write s now key r (.keyed key) = some r ∧
      ∀ id, id ≠ .keyed key → write s now key r id = liveAt s now id := by
  refine ⟨by simp [write, put], ?_⟩
  intro id hid
  simp [write, put, hid]

theorem write_then_lookup {V : Type} (legacy : Bool) (s : Store V) (now : Int) (key : String)
    (r : Row V) (h : r.live now = true) :
    lookup legacy (write s now key r) now key = some r.value := by
  simp [lookup, liveAt, write, put, h]

private theorem liveAt_liveAt {V : Type} (s : Store V) (now : Int) (id : RowId) :
    liveAt (liveAt s now) now id = liveAt s now id := by
  unfold liveAt; cases h : s id with
  | none => rfl
  | some r => by_cases hl : r.live now <;> simp [hl]

theorem write_other_keys {V : Type} (legacy : Bool) (s : Store V) (now : Int)
    (key k : String) (r : Row V) (hk : k ≠ key) :
    lookup legacy (write s now key r) now k = lookup legacy s now k := by
  have h1 : write s now key r (.keyed k) = liveAt s now (.keyed k) := by
    simp [write, put, hk]
  have h2 : write s now key r (.legacyDigest k) = liveAt s now (.legacyDigest k) := by
    simp [write, put]
  have e1 : liveAt (write s now key r) now (.keyed k) = liveAt s now (.keyed k) := by
    unfold liveAt at *; rw [h1]; exact liveAt_liveAt s now (.keyed k)
  have e2 : liveAt (write s now key r) now (.legacyDigest k) =
      liveAt s now (.legacyDigest k) := by
    unfold liveAt at *; rw [h2]; exact liveAt_liveAt s now (.legacyDigest k)
  simp only [lookup, e1, e2]

theorem claim_never_replaces_live {V : Type} (s : Store V) (now : Int) (key : String)
    (r : Row V) (h : (liveAt s now (.keyed key)).isSome = true) :
    (claim s now key r).2 = false ∧
      lookup false (claim s now key r).1 now key = lookup false s now key := by
  simp only [claim, h, if_true]
  exact ⟨trivial, by simp only [lookup, liveAt_liveAt]⟩

theorem delete_then_lookup {V : Type} (s : Store V) (now : Int) (key : String) :
    lookup false (delete s key).1 now key = none := by
  simp [lookup, liveAt, delete, put]

theorem take_single_use {V : Type} (s : Store V) (now later : Int) (key : String) (v : V)
    (h : (take s now key).2 = some v) :
    lookup false (take s now key).1 later key = none ∧
      (take (take s now key).1 later key).2 = none := by
  unfold take at h ⊢
  cases hk : liveAt s now (.keyed key) with
  | none => simp [hk] at h
  | some r => simp [lookup, liveAt, put]

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

private theorem rekeyIfLive_other_ids {V : Type} (s : Store V) (now : Int) (key : String)
    (id : RowId) (h : id ∉ addresses true key) : rekeyIfLive s now key id = s id := by
  unfold rekeyIfLive; split
  · exact rekey_other_ids s now key id h
  · rfl

private def NoExpiryKeyed {V : Type} (s : Store V) (key : String) : Prop :=
  ∃ c, s (.keyed key) = some c ∧ c.expiresAt = none

private def NoExpiryPending {V : Type} (s : Store V) (now : Int) (key : String) : Prop :=
  NoExpiryKeyed s key ∨ (liveAt s now (.keyed key) = none ∧
    ∃ r, s (.legacyDigest key) = some r ∧ r.expiresAt = none)

private theorem rekey_keeps_noExpiryKeyed {V : Type} (s : Store V) (now : Int)
    (key k : String) (h : NoExpiryKeyed s key) : NoExpiryKeyed (rekeyIfLive s now k) key := by
  obtain ⟨c, hc, he⟩ := h
  refine ⟨c, ?_, he⟩
  by_cases hk : k = key
  · subst hk; unfold rekeyIfLive; split
    · exact rekey_keeps_keyed s now k c hc (by simp [Row.live, he])
    · exact hc
  · rw [rekeyIfLive_other_ids s now k (.keyed key) (by simp [addresses]; exact fun h => hk h.symm)]
    exact hc

private theorem rekey_settles {V : Type} (s : Store V) (now : Int) (key : String)
    (h : NoExpiryPending s now key) : NoExpiryKeyed (rekeyIfLive s now key) key := by
  rcases h with h | ⟨hk, r, hl, he⟩
  · exact rekey_keeps_noExpiryKeyed s now key key h
  · have hv : (liveAt s now (.legacyDigest key)).isSome = true := by
      simp [liveAt, hl, Row.live, he]
    exact ⟨r, by simp [rekeyIfLive, hv, rekey, hl, hk, put], he⟩

private theorem rekey_keeps_pending {V : Type} (s : Store V) (now : Int) (key k : String)
    (hne : k ≠ key) (h : NoExpiryPending s now key) :
    NoExpiryPending (rekeyIfLive s now k) now key := by
  have hkid : RowId.keyed key ∉ addresses true k := by
    simp [addresses]; exact fun h => hne h.symm
  have hlid : RowId.legacyDigest key ∉ addresses true k := by
    simp [addresses]; exact fun h => hne h.symm
  rcases h with h | ⟨hk, r, hl, he⟩
  · exact Or.inl (rekey_keeps_noExpiryKeyed s now key k h)
  · refine Or.inr ⟨?_, r, by rw [rekeyIfLive_other_ids s now k _ hlid]; exact hl, he⟩
    unfold liveAt at hk ⊢
    rw [rekeyIfLive_other_ids s now k _ hkid]
    exact hk

private theorem migrate_keeps_noExpiryKeyed {V : Type} (now : Int) (keys : List String)
    (key : String) : ∀ s : Store V, NoExpiryKeyed s key → NoExpiryKeyed (migrate s now keys) key := by
  induction keys with
  | nil => intro s h; exact h
  | cons k rest ih =>
    intro s h; exact ih (rekeyIfLive s now k) (rekey_keeps_noExpiryKeyed s now key k h)

private theorem migrate_settles {V : Type} (now : Int) (keys : List String) (key : String)
    (hmem : key ∈ keys) : ∀ s : Store V, NoExpiryPending s now key →
      NoExpiryKeyed (migrate s now keys) key := by
  induction keys with
  | nil => cases hmem
  | cons k rest ih =>
    intro s h
    by_cases hk : k = key
    · subst hk
      exact migrate_keeps_noExpiryKeyed now rest k (rekeyIfLive s now k) (rekey_settles s now k h)
    · have hrest : key ∈ rest := by
        rcases List.mem_cons.mp hmem with h' | h'
        · exact absurd h'.symm hk
        · exact h'
      exact ih hrest (rekeyIfLive s now k) (rekey_keeps_pending s now key k hk h)

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

/-- Startup serves only once `legacyRows()` lists no live legacy row; then
removing the fallback changes no read. -/
theorem served_store_needs_no_fallback {V : Type} (s : Store V) (now : Int) (key : String)
    (h : ∀ k, liveAt s now (.legacyDigest k) = none) :
    lookup false s now key = lookup true s now key := by
  cases hk : liveAt s now (.keyed key) <;> simp_all [lookup]

end OpenSesame.AuthPolicy.Storage
