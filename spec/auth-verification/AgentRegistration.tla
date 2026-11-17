----------------------- MODULE AgentRegistration -----------------------
EXTENDS Naturals

\* A fresh registration in one process with a monotonic clock, two possible
\* claimant identifiers and at most three successful version increments.
\* Claimant authentication, key proof, token issuance, persistence races,
\* resources, and authorization are external to this domain abstraction.

States == {"unclaimed", "claim_pending", "claimed", "expired", "revoked"}
Times == {"before", "deadline", "after"}
Actors == {"alice", "bob"}
Actions == {"init", "advance", "pending", "claim", "expire", "revoke"}
Results == {"none", "changed", "unchanged", "invalid", "expired-error", "invariant-error"}

VARIABLES registration, previous, now, action, result, actor
vars == <<registration, previous, now, action, result, actor>>

Init ==
  /\ registration = [status |-> "unclaimed", id |-> "registration",
       kind |-> "anonymous", owner |-> "original", claimant |-> "none",
       version |-> 0, assertionVersion |-> 1]
  /\ previous = registration /\ now = "before" /\ action = "init"
  /\ result = "none" /\ actor = "none"

Advance ==
  /\ now # "after"
  /\ now' = IF now = "before" THEN "deadline" ELSE "after"
  /\ previous' = registration /\ action' = "advance" /\ result' = "unchanged"
  /\ UNCHANGED <<registration, actor>>

NotLive == registration.status \in {"expired", "revoked"} \/
           (registration.status # "claimed" /\ now # "before")

Pending ==
  /\ registration.version < 3
  /\ previous' = registration /\ action' = "pending" /\ actor' = "none"
  /\ IF NotLive
       THEN /\ registration' = registration /\ result' = "expired-error"
       ELSE IF registration.status \in {"unclaimed", "claim_pending"}
         THEN /\ registration' = [registration EXCEPT !.status = "claim_pending", !.version = @ + 1]
              /\ result' = "changed"
         ELSE /\ registration' = registration /\ result' = "invalid"
  /\ UNCHANGED now

Claim(person) ==
  /\ registration.version < 3 /\ person \in Actors \cup {"none"}
  /\ previous' = registration /\ action' = "claim" /\ actor' = person
  /\ IF NotLive
       THEN /\ registration' = registration /\ result' = "expired-error"
       ELSE IF person = "none"
         THEN /\ registration' = registration /\ result' = "invariant-error"
         ELSE IF registration.status # "claim_pending"
           THEN /\ registration' = registration /\ result' = "invalid"
           ELSE /\ registration' = [registration EXCEPT !.status = "claimed",
                        !.owner = person, !.claimant = person,
                        !.version = @ + 1, !.assertionVersion = @ + 1]
                /\ result' = "changed"
  /\ UNCHANGED now

Expire ==
  /\ registration.version < 3
  /\ previous' = registration /\ action' = "expire" /\ actor' = "none"
  /\ IF registration.status = "expired"
       THEN /\ registration' = registration /\ result' = "unchanged"
       ELSE IF registration.status \in {"claimed", "revoked"}
         THEN /\ registration' = registration /\ result' = "invalid"
         ELSE IF now = "before"
           THEN /\ registration' = registration /\ result' = "invariant-error"
           ELSE /\ registration' = [registration EXCEPT !.status = "expired", !.version = @ + 1]
                /\ result' = "changed"
  /\ UNCHANGED now

Revoke ==
  /\ registration.version < 3
  /\ previous' = registration /\ action' = "revoke" /\ actor' = "none"
  /\ IF registration.status = "revoked"
       THEN /\ registration' = registration /\ result' = "unchanged"
       ELSE IF registration.status = "expired"
         THEN /\ registration' = registration /\ result' = "invalid"
         ELSE /\ registration' = [registration EXCEPT !.status = "revoked", !.version = @ + 1]
              /\ result' = "changed"
  /\ UNCHANGED now

Next == Advance \/ Pending \/ (\E person \in Actors \cup {"none"}: Claim(person)) \/ Expire \/ Revoke
Spec == Init /\ [][Next]_vars

TypeOK == /\ registration.status \in States /\ registration.version \in 0..3
          /\ registration.assertionVersion \in 1..2
          /\ registration.owner \in Actors \cup {"original"}
          /\ registration.claimant \in Actors \cup {"none"}
          /\ now \in Times /\ action \in Actions /\ result \in Results
          /\ actor \in Actors \cup {"none"}
ImmutableIdentity == registration.id = "registration" /\ registration.kind = "anonymous"
TerminalStateStable == previous.status \in {"expired", "revoked"} => registration.status = previous.status
VersionTracksChange == registration.version = previous.version + IF result = "changed" THEN 1 ELSE 0
RejectedDoesNotChange == result \in {"invalid", "expired-error", "invariant-error", "unchanged"} => registration = previous
ClaimRequiresPendingAndPerson ==
  action = "claim" /\ result = "changed" =>
    previous.status = "claim_pending" /\ actor \in Actors /\
    registration.owner = actor /\ registration.claimant = actor
NoLateClaim == action = "claim" /\ result = "changed" => now = "before"
ClaimedKeepsOwner == registration.claimant # "none" => registration.owner = registration.claimant
NoEarlyExpiry == action = "expire" /\ result = "changed" => now # "before"

\* Deliberately false reachability checks for negative controls.
ClaimUnreachable == registration.status # "claimed"
PostDeadlineRevokeUnreachable ==
  ~(action = "revoke" /\ previous.status = "claimed" /\ now # "before" /\ result = "changed")
=============================================================================
