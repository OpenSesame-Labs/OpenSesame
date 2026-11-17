------------------------ MODULE AuthorizationRequest ------------------------
EXTENDS Naturals

\* Finite lifecycle abstraction of the os-domain authorization-request
\* machine. A call's time is before, exactly at, or after the deadline.
\* It models a fresh pending request with no prior decision metadata, valid
\* dates, and no outside mutations. Actor authentication, authorization,
\* persistence concurrency, and executor digest comparison are out of scope.

Statuses == {"pending", "approved", "denied", "cancelled", "expired"}
Decisions == {"approved", "denied", "cancelled"}
Times == {"before", "deadline", "after"}
Kinds == {"human", "agent"}
Actors == {"alice", "bob"}
Digests == {"digest-a", "digest-b"}
None == "none"

VARIABLES initialVersion, initialDigest, initialPrincipal, request, previous,
          action, time, result, decision, actor, kind

vars == <<initialVersion, initialDigest, initialPrincipal, request, previous,
          action, time, result, decision, actor, kind>>

Init ==
  /\ initialVersion \in {0, 1, 17}
  /\ initialDigest \in Digests
  /\ initialPrincipal \in Actors
  /\ request = [status |-> "pending", version |-> initialVersion,
                 digest |-> initialDigest, principal |-> initialPrincipal,
                 decidedAt |-> None, decidedBy |-> None,
                 decidedKind |-> None, provenance |-> None]
  /\ previous = request
  /\ action = None
  /\ time = None
  /\ result = None
  /\ decision = None
  /\ actor = None
  /\ kind = None

Settle(target, decider, deciderKind, at) ==
  /\ target \in Decisions
  /\ decider \in Actors
  /\ deciderKind \in Kinds
  /\ at \in Times
  /\ previous' = request
  /\ action' = "settle"
  /\ time' = at
  /\ decision' = target
  /\ actor' = decider
  /\ kind' = deciderKind
  /\ IF request.status # "pending"
        THEN /\ request' = request
             /\ result' = "invalid"
        ELSE IF at # "before"
          THEN /\ request' = request
               /\ result' = "expired-error"
          ELSE /\ request' = [request EXCEPT
                     !.status = target, !.version = @ + 1,
                     !.decidedAt = at, !.decidedBy = decider,
                     !.decidedKind = deciderKind, !.provenance = "decision"]
               /\ result' = "settled"
  /\ UNCHANGED <<initialVersion, initialDigest, initialPrincipal>>

Withdraw(at) ==
  /\ at \in Times
  /\ previous' = request
  /\ action' = "withdraw"
  /\ time' = at
  /\ decision' = None
  /\ actor' = None
  /\ kind' = None
  /\ IF request.status # "pending"
        THEN /\ request' = request
             /\ result' = "invalid"
        ELSE IF at # "before"
          THEN /\ request' = request
               /\ result' = "expired-error"
          ELSE /\ request' = [request EXCEPT
                     !.status = "cancelled", !.version = @ + 1,
                     !.decidedAt = at, !.provenance = "withdrawal"]
               /\ result' = "withdrawn"
  /\ UNCHANGED <<initialVersion, initialDigest, initialPrincipal>>

Read(at) ==
  /\ at \in Times
  /\ previous' = request
  /\ action' = "read"
  /\ time' = at
  /\ decision' = None
  /\ actor' = None
  /\ kind' = None
  /\ IF request.status = "pending" /\ at # "before"
        THEN /\ request' = [request EXCEPT
                   !.status = "expired", !.version = @ + 1,
                   !.provenance = "expiry"]
             /\ result' = "expired"
        ELSE /\ request' = request
             /\ result' = "unchanged"
  /\ UNCHANGED <<initialVersion, initialDigest, initialPrincipal>>

Next == (\E target \in Decisions, by \in Actors, k \in Kinds, at \in Times:
           Settle(target, by, k, at))
        \/ (\E at \in Times: Withdraw(at) \/ Read(at))
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ initialVersion \in {0, 1, 17}
  /\ initialDigest \in Digests
  /\ initialPrincipal \in Actors
  /\ request.status \in Statuses
  /\ request.version \in {0, 1, 2, 17, 18}
  /\ request.digest \in Digests
  /\ request.principal \in Actors
  /\ request.decidedAt \in Times \cup {None}
  /\ request.decidedBy \in Actors \cup {None}
  /\ request.decidedKind \in Kinds \cup {None}
  /\ request.provenance \in {None, "decision", "withdrawal", "expiry"}
  /\ action \in {None, "settle", "withdraw", "read"}
  /\ time \in Times \cup {None}
  /\ result \in {None, "invalid", "expired-error", "settled", "withdrawn",
                   "expired", "unchanged"}
  /\ decision \in Decisions \cup {None}
  /\ actor \in Actors \cup {None}
  /\ kind \in Kinds \cup {None}

TerminalNeverChanges == previous.status # "pending" => request = previous
RejectedNeverChanges == result \in {"invalid", "expired-error"} => request = previous
BoundFieldsPreserved ==
  /\ request.digest = initialDigest
  /\ request.principal = initialPrincipal
VersionAdvancesOnce ==
  request.version = initialVersion + IF request.status = "pending" THEN 0 ELSE 1
NoLateDecision == result \in {"settled", "withdrawn"} => time = "before"
DecisionMatchesInput ==
  result = "settled" =>
    /\ request.status = decision
    /\ request.decidedBy = actor
    /\ request.decidedKind = kind
    /\ request.decidedAt = time
WithdrawalNamesNoDecider ==
  request.provenance = "withdrawal" =>
    /\ request.status = "cancelled"
    /\ request.decidedBy = None
    /\ request.decidedKind = None
ExpiryHasNoDecision ==
  request.provenance = "expiry" =>
    /\ request.status = "expired"
    /\ request.decidedAt = None
    /\ request.decidedBy = None
    /\ request.decidedKind = None
ApprovalComesFromDecision ==
  request.status = "approved" => request.provenance = "decision"
=============================================================================
