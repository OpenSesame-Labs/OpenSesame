--------------------- MODULE IssuerTrustResolution ---------------------
EXTENDS Naturals

\* One normalized, nonempty issuer. The static registry is fixed; the two
\* backing records and operator approval can change between reads. Repository
\* reads return immutable snapshots and each selection step is atomic here.
\* URL validation, issuer ownership, record uniqueness and credentials are
\* external assumptions, not conclusions of this model.

OrgStates == {"absent", "active", "suspended", "deleted"}
ByoStates == {"absent", "active", "disabled"}
Phases == {"static", "org", "byo", "done"}
Results == {"pending", "static", "org", "byo", "none"}

VARIABLES staticTrusted, orgState, orgApproved, byoState, phase, result,
          readOrgState, readApproval, readByoState, action
vars == <<staticTrusted, orgState, orgApproved, byoState, phase, result,
          readOrgState, readApproval, readByoState, action>>

Init == /\ staticTrusted \in BOOLEAN /\ orgState \in OrgStates
        /\ orgApproved \in BOOLEAN /\ byoState \in ByoStates
        /\ phase = "static" /\ result = "pending"
        /\ readOrgState = "absent" /\ readApproval = FALSE
        /\ readByoState = "absent" /\ action = "init"

ReadStatic ==
  /\ phase = "static"
  /\ phase' = IF staticTrusted THEN "done" ELSE "org"
  /\ result' = IF staticTrusted THEN "static" ELSE "pending"
  /\ action' = "read-static"
  /\ UNCHANGED <<staticTrusted, orgState, orgApproved, byoState, readOrgState,
                 readApproval, readByoState>>

ReadOrg ==
  /\ phase = "org"
  /\ readOrgState' = orgState /\ readApproval' = orgApproved
  /\ LET eligible == orgState = "active" /\ orgApproved
     IN /\ phase' = IF eligible THEN "done" ELSE "byo"
        /\ result' = IF eligible THEN "org" ELSE "pending"
  /\ action' = "read-org"
  /\ UNCHANGED <<staticTrusted, orgState, orgApproved, byoState, readByoState>>

ReadByo ==
  /\ phase = "byo"
  /\ readByoState' = byoState /\ phase' = "done"
  /\ result' = IF byoState = "active" THEN "byo" ELSE "none"
  /\ action' = "read-byo"
  /\ UNCHANGED <<staticTrusted, orgState, orgApproved, byoState, readOrgState,
                 readApproval>>

ChangeOrg(state, approved) ==
  /\ state \in OrgStates /\ approved \in BOOLEAN
  /\ orgState' = state /\ orgApproved' = approved /\ action' = "change-org"
  /\ UNCHANGED <<staticTrusted, byoState, phase, result, readOrgState,
                 readApproval, readByoState>>

ChangeByo(state) ==
  /\ state \in ByoStates /\ byoState' = state /\ action' = "change-byo"
  /\ UNCHANGED <<staticTrusted, orgState, orgApproved, phase, result,
                 readOrgState, readApproval, readByoState>>

Next == ReadStatic \/ ReadOrg \/ ReadByo \/
        (\E state \in OrgStates, approved \in BOOLEAN: ChangeOrg(state, approved)) \/
        (\E state \in ByoStates: ChangeByo(state))
Spec == Init /\ [][Next]_vars

TypeOK == /\ staticTrusted \in BOOLEAN /\ orgState \in OrgStates
          /\ orgApproved \in BOOLEAN /\ byoState \in ByoStates /\ phase \in Phases
          /\ result \in Results /\ readOrgState \in OrgStates /\ readApproval \in BOOLEAN
          /\ readByoState \in ByoStates
          /\ action \in {"init", "read-static", "read-org", "read-byo", "change-org", "change-byo"}
StaticPrecedes == phase = "done" /\ staticTrusted => result = "static"
OrgPrecedesByo == phase = "done" /\ ~staticTrusted /\
  readOrgState = "active" /\ readApproval => result = "org"
OrgWasAdmitted == result = "org" => readOrgState = "active" /\ readApproval
ByoWasActive == result = "byo" => readByoState = "active"
NoUnwitnessedTrust == result = "none" =>
  ~staticTrusted /\ ~(readOrgState = "active" /\ readApproval) /\ readByoState # "active"

\* Deliberately false reachability assertions document actual snapshot semantics.
SuspendedOrgWithByoUnreachable ==
  ~(result = "byo" /\ readOrgState = "suspended")
RevokedAfterResolutionUnreachable ==
  ~(result = "org" /\ orgState = "suspended")
=============================================================================
