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

-- `lean --run` needs an unqualified entrypoint.
def main : IO Unit := OpenSesame.AuthPolicy.main
