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
    ∀ {V : Type} (s : Store V) (now : Int) (key : String) (r : Row V),
    write s now key r (.keyed key) = some r ∧
      ∀ id, id ≠ .keyed key → write s now key r id = liveAt s now id

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.write_then_lookup :
    ∀ {V : Type} (legacy : Bool) (s : Store V) (now : Int) (key : String) (r : Row V)
    (_h : r.live now = true),
    lookup legacy (write s now key r) now key = some r.value

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.write_other_keys :
    ∀ {V : Type} (legacy : Bool) (s : Store V) (now : Int) (key k : String) (r : Row V)
    (_hk : k ≠ key), lookup legacy (write s now key r) now k = lookup legacy s now k

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.claim_never_replaces_live :
    ∀ {V : Type} (s : Store V) (now : Int) (key : String) (r : Row V)
    (_h : (liveAt s now (.keyed key)).isSome = true),
    (claim s now key r).2 = false ∧
      lookup false (claim s now key r).1 now key = lookup false s now key

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.delete_then_lookup :
    ∀ {V : Type} (s : Store V) (now : Int) (key : String),
    lookup false (delete s key).1 now key = none

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.take_single_use :
    ∀ {V : Type} (s : Store V) (now later : Int) (key : String) (v : V)
    (_h : (take s now key).2 = some v),
    lookup false (take s now key).1 later key = none ∧
      (take (take s now key).1 later key).2 = none

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.rekey_other_ids :
    ∀ {V : Type} (s : Store V) (now : Int) (key : String) (id : RowId)
    (_h : id ∉ addresses true key), rekey s now key id = s id

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.rekey_preserves_lookup :
    ∀ {V : Type} (s : Store V) (now : Int) (key : String),
    lookup true (rekey s now key) now key = lookup true s now key

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.migration_keeps_no_expiry_rows :
    ∀ {V : Type} (s : Store V) (now : Int) (keys : List String) (key : String) (r : Row V)
    (_hl : s (.legacyDigest key) = some r) (_he : r.expiresAt = none)
    (_hk : liveAt s now (.keyed key) = none ∨ ∃ c, s (.keyed key) = some c ∧ c.expiresAt = none)
    (_hmem : key ∈ keys) (later : Int),
    (lookup false (migrate s now keys) later key).isSome = true

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.legacy_only_row_refused :
    ∀ {V : Type} (s : Store V) (now : Int) (key : String)
    (_h : s (.keyed key) = none), lookup false s now key = none

open OpenSesame.AuthPolicy.Storage in
#require_theorem OpenSesame.AuthPolicy.Storage.served_store_needs_no_fallback :
    ∀ {V : Type} (s : Store V) (now : Int) (key : String)
    (_h : ∀ k, liveAt s now (.legacyDigest k) = none),
    lookup false s now key = lookup true s now key

open OpenSesame.AuthPolicy OpenSesame.AuthPolicy.Session in
#require_theorem OpenSesame.AuthPolicy.Session.resolves_requires_session_admitted :
    ∀ (f : SessionFacts) (now : Int) (_h : resolves f now = true),
    sessionAdmitted f.hasPrefix f.mapped f.present f.unrevoked f.expiresAt now f.principal = true

open OpenSesame.AuthPolicy.Session in
#require_theorem OpenSesame.AuthPolicy.Session.cleanup_pending_session_denied :
    ∀ (f : SessionFacts) (now : Int) (_h : f.cleanupPending = true), resolves f now = false

open OpenSesame.AuthPolicy.Session in
#require_theorem OpenSesame.AuthPolicy.Session.pending_withdrawal_session_denied :
    ∀ (f : SessionFacts) (now : Int) (_h : f.withdrawalPending = true), resolves f now = false

open OpenSesame.AuthPolicy.Session in
#require_theorem OpenSesame.AuthPolicy.Session.bound_never_falls_back :
    ∀ (b : BoundFacts) (bearer : Bearer) (allow req : Bool) (c : CookieFacts) (now : Int),
    middleware (some b) bearer allow req c now = .bound ∨
      middleware (some b) bearer allow req c now = .reject

open OpenSesame.AuthPolicy.Session in
#require_theorem OpenSesame.AuthPolicy.Session.bound_admission_requires :
    ∀ (b : BoundFacts) (bearer : Bearer) (allow req : Bool) (c : CookieFacts) (now : Int)
    (_h : middleware (some b) bearer allow req c now = .bound),
    b.idValid ∧ b.proofPresent ∧ b.expectedValid ∧ b.cookiePresent ∧ b.originAllowed ∧
      resolves b.cookie now ∧ b.sessionMatches ∧ b.principalMatches ∧ b.proofMatches

open OpenSesame.AuthPolicy.Session in
#require_theorem OpenSesame.AuthPolicy.Session.required_bearer_never_uses_cookie :
    ∀ (bearer : Bearer) (allow : Bool) (c : CookieFacts) (now : Int) (_hb : bearer ≠ .none),
    middleware none bearer allow true c now ≠ .cookie ∧
      middleware none bearer allow true c now ≠ .anonymous

open OpenSesame.AuthPolicy.Session in
#require_theorem OpenSesame.AuthPolicy.Session.bearer_requires_resolution :
    ∀ (bound : Option BoundFacts) (bearer : Bearer) (allow req : Bool) (c : CookieFacts)
    (now : Int) (_h : middleware bound bearer allow req c now = .bearer),
    bound = none ∧ ∃ f, bearer = .session f ∧ resolves f now = true

open OpenSesame.AuthPolicy OpenSesame.AuthPolicy.Session in
#require_theorem OpenSesame.AuthPolicy.Session.principal_bearer_requires :
    ∀ (bound : Option BoundFacts) (bearer : Bearer) (allow req : Bool) (c : CookieFacts)
    (now : Int) (_h : middleware bound bearer allow req c now = .principalBearer),
    bound = none ∧ allow = true ∧ ∃ p, bearer = .principal p false ∧
      principalCanAuthenticate p = true

open OpenSesame.AuthPolicy.Session in
#require_theorem OpenSesame.AuthPolicy.Session.cookie_requires :
    ∀ (bound : Option BoundFacts) (bearer : Bearer) (allow req : Bool) (c : CookieFacts)
    (now : Int) (_h : middleware bound bearer allow req c now = .cookie),
    bound = none ∧ c.present ∧ c.originAllowed ∧ resolves c.session now ∧
      (req = false ∨ bearer = .none)

open OpenSesame.AuthPolicy OpenSesame.AuthPolicy.Session in
#require_theorem OpenSesame.AuthPolicy.Session.admitted_session_satisfies_auth_s1 :
    ∀ (bound : Option BoundFacts) (bearer : Bearer) (allow req : Bool) (c : CookieFacts)
    (now : Int) (_h : middleware bound bearer allow req c now = .bound ∨
      middleware bound bearer allow req c now = .bearer ∨
      middleware bound bearer allow req c now = .cookie),
    ∃ f : SessionFacts, sessionAdmitted f.hasPrefix f.mapped f.present f.unrevoked f.expiresAt
      now f.principal = true ∧ f.cleanupPending = false ∧ f.withdrawalPending = false

open OpenSesame.AuthPolicy.Transport in
#require_theorem OpenSesame.AuthPolicy.Transport.stale_evidence_refused :
    ∀ (e : Evidence) (_h : e.current = false),
    peerView e = false ∧ originatingView e = false ∧ admit e = .expired ∧ bindingPeer e = none

open OpenSesame.AuthPolicy.Transport in
#require_theorem OpenSesame.AuthPolicy.Transport.admit_ok_requires :
    ∀ (e : Evidence) (_h : admit e = .ok),
    e.current = true ∧ e.bindingAllows = true ∧ e.peer ≠ some false ∧
      (e.originating = some true ∨ (e.originating = none ∧ e.peer = some true))

open OpenSesame.AuthPolicy.Transport in
#require_theorem OpenSesame.AuthPolicy.Transport.ingress_never_acts_as_client :
    ∀ (e : Evidence) (_h : e.policy = .trustedIngress),
    bindingPeer e ≠ some .peer ∧ (admit e = .ok → e.originating = some true)

open OpenSesame.AuthPolicy.Transport in
#require_theorem OpenSesame.AuthPolicy.Transport.forwarded_error_never_binds_peer :
    ∀ (e : Evidence) (_h : e.originatingError = true), bindingPeer e ≠ some .peer

open OpenSesame.AuthPolicy.Transport in
#require_theorem OpenSesame.AuthPolicy.Transport.trust_change_stales :
    ∀ (g : Gens) (rs : List Bool) (_h : true ∈ rs),
    recordedCurrent g.trust (reloads g rs) = false

open OpenSesame.AuthPolicy.Transport in
#require_theorem OpenSesame.AuthPolicy.Transport.credential_reload_keeps_current :
    ∀ (g : Gens) (rs : List Bool) (_h : ∀ r ∈ rs, r = false),
    recordedCurrent g.trust (reloads g rs) = true

open OpenSesame.AuthPolicy.SignOut in
#require_theorem OpenSesame.AuthPolicy.SignOut.exit_attempts_every_step :
    ∀ (fails : Step → Bool) (vaultOpen : Bool) (s : Step) (_h : s ∈ steps),
    s ∈ (signOut fails vaultOpen).attempted

open OpenSesame.AuthPolicy.SignOut in
#require_theorem OpenSesame.AuthPolicy.SignOut.exit_ends_session :
    ∀ (fails : Step → Bool) (vaultOpen : Bool),
    Step.endSession ∈ (signOut fails vaultOpen).attempted

open OpenSesame.AuthPolicy.SignOut in
#require_theorem OpenSesame.AuthPolicy.SignOut.exit_locks_open_vault :
    ∀ (fails : Step → Bool) (vaultOpen : Bool) (_h : vaultOpen = true),
    Step.lockVault ∈ (signOut fails vaultOpen).attempted

open OpenSesame.AuthPolicy.SignOut in
#require_theorem OpenSesame.AuthPolicy.SignOut.exit_incomplete_iff_failure :
    ∀ (fails : Step → Bool) (vaultOpen : Bool),
    (signOut fails vaultOpen).incomplete = true ↔
      ∃ s ∈ (signOut fails vaultOpen).attempted, fails s = true

open OpenSesame.AuthPolicy.SignOut in
#require_theorem OpenSesame.AuthPolicy.SignOut.exit_settles_only_when_complete :
    ∀ (fails : Step → Bool) (vaultOpen : Bool),
    (signOut fails vaultOpen).settles = !(signOut fails vaultOpen).incomplete
