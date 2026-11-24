/- Independently maintained required theorem types. Review each change against the documented requirement. -/
open OpenSesame.AuthPolicy

#require_theorem OpenSesame.AuthPolicy.missing_principal_denied :
    principalVerdict none = .notFound

#require_theorem OpenSesame.AuthPolicy.provisional_principal_denied :
    principalVerdict (some .provisional) = .provisional

#require_theorem OpenSesame.AuthPolicy.admitted_principal_not_provisional :
    ∀ (a : Assurance)
    (_h : principalVerdict (some a) = .admitted),
    a ≠ .provisional

#require_theorem OpenSesame.AuthPolicy.bad_session_prefix_denied :
    ∀ (mapped present unrevoked : Bool)
    (expiresAt now : Int) (principal : SessionPrincipal),
    sessionAdmitted false mapped present unrevoked expiresAt now principal = false

#require_theorem OpenSesame.AuthPolicy.unmapped_session_denied :
    ∀ (hasPrefix present unrevoked : Bool)
    (expiresAt now : Int) (principal : SessionPrincipal),
    sessionAdmitted hasPrefix false present unrevoked expiresAt now principal = false

#require_theorem OpenSesame.AuthPolicy.missing_session_denied :
    ∀ (hasPrefix mapped unrevoked : Bool)
    (expiresAt now : Int) (principal : SessionPrincipal),
    sessionAdmitted hasPrefix mapped false unrevoked expiresAt now principal = false

#require_theorem OpenSesame.AuthPolicy.revoked_session_denied :
    ∀ (hasPrefix mapped present : Bool)
    (expiresAt now : Int) (principal : SessionPrincipal),
    sessionAdmitted hasPrefix mapped present false expiresAt now principal = false

#require_theorem OpenSesame.AuthPolicy.expired_session_denied :
    ∀ (hasPrefix mapped present unrevoked : Bool)
    (expiresAt now : Int) (principal : SessionPrincipal) (_h : expiresAt ≤ now),
    sessionAdmitted hasPrefix mapped present unrevoked expiresAt now principal = false

#require_theorem OpenSesame.AuthPolicy.closed_principal_session_denied :
    ∀ (hasPrefix mapped present unrevoked : Bool)
    (expiresAt now : Int),
    sessionAdmitted hasPrefix mapped present unrevoked expiresAt now .closed = false

#require_theorem OpenSesame.AuthPolicy.suspended_principal_session_denied :
    ∀ (hasPrefix mapped present unrevoked : Bool)
    (expiresAt now : Int),
    sessionAdmitted hasPrefix mapped present unrevoked expiresAt now .suspended = false

#require_theorem OpenSesame.AuthPolicy.missing_principal_session_denied :
    ∀ (hasPrefix mapped present unrevoked : Bool)
    (expiresAt now : Int),
    sessionAdmitted hasPrefix mapped present unrevoked expiresAt now .missing = false

#require_theorem OpenSesame.AuthPolicy.not_visible_at_expiry :
    ∀ (state : ProjectState) (now : Int),
    isVisible state (some now) now = false

#require_theorem OpenSesame.AuthPolicy.not_visible_after_expiry :
    ∀ (state : ProjectState) (expiresAt now : Int)
    (_h : expiresAt ≤ now),
    isVisible state (some expiresAt) now = false

#require_theorem OpenSesame.AuthPolicy.deleted_project_not_visible :
    ∀ (expiresAt : Option Int) (now : Int),
    isVisible .deleted expiresAt now = false

#require_theorem OpenSesame.AuthPolicy.hidden_project_denied :
    ∀ (present : Bool) (role : Option Role),
    projectDecision present false role = none

#require_theorem OpenSesame.AuthPolicy.absent_project_denied :
    ∀ (visible : Bool) (role : Option Role),
    projectDecision false visible role = none

#require_theorem OpenSesame.AuthPolicy.no_role_denied :
    ∀ (present visible : Bool),
    projectDecision present visible none = none

#require_theorem OpenSesame.AuthPolicy.member_never_receives_admin :
    ∀ (present visible : Bool),
    (proofsFor (projectDecision present visible (some .member))).admin = false

#require_theorem OpenSesame.AuthPolicy.nonowner_never_receives_owner :
    ∀ (present visible : Bool) (role : Option Role)
    (_h : role ≠ some .owner),
    (proofsFor (projectDecision present visible role)).owner = false

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.lookup_reads_only_addresses :
    ∀ {V : Type} (legacy : Bool) (s t : Store V) (now : Int) (key : String)
    (_h : ∀ id ∈ addresses legacy key, s id = t id),
    lookup legacy s now key = lookup legacy t now key

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.legacy_free_addresses_keyed_only :
    ∀ (key : String), ∀ id ∈ addresses false key, id = RowId.keyed key

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.write_stores_only_keyed :
    ∀ {V : Type} (s : Store V) (key : String) (r : Row V),
    (write s key r (.keyed key)).isSome ∧ write s key r (.legacyDigest key) = none ∧
      ∀ id, id ∉ addresses true key → write s key r id = s id

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.write_then_lookup :
    ∀ {V : Type} (legacy : Bool) (s : Store V) (key : String) (r : Row V) (now : Int)
    (_h : r.live now = true),
    lookup legacy (write s key r) now key = some r.value

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.rekey_other_ids :
    ∀ {V : Type} (s : Store V) (key : String) (id : RowId)
    (_h : id ∉ addresses true key), rekey s key id = s id

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.rekey_preserves_lookup :
    ∀ {V : Type} (s : Store V) (key : String) (now : Int)
    (_h : ∀ c, s (.keyed key) = some c → c.live now = true),
    lookup true (rekey s key) now key = lookup true s now key

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.migration_keeps_no_expiry_rows :
    ∀ {V : Type} (s : Store V) (keys : List String) (key : String) (r : Row V)
    (_hl : s (.legacyDigest key) = some r) (_he : r.expiresAt = none)
    (_hk : s (.keyed key) = none ∨ ∃ c, s (.keyed key) = some c ∧ c.expiresAt = none)
    (_hmem : key ∈ keys) (now : Int),
    (lookup false (migrate s keys) now key).isSome = true

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.rekey_drops_live_legacy_behind_expired_keyed :
    ∃ (s : Store Nat) (key : String) (now : Int),
      lookup true s now key = some 1 ∧ lookup true (rekey s key) now key = none

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.legacy_only_row_refused :
    ∀ {V : Type} (s : Store V) (now : Int) (key : String)
    (_h : s (.keyed key) = none), lookup false s now key = none

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.served_store_needs_no_fallback :
    ∀ {V : Type} (s : Store V) (now : Int) (key : String)
    (_h : ∀ k, s (.legacyDigest k) = none),
    lookup false s now key = lookup true s now key
