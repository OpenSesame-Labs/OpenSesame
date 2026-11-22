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
