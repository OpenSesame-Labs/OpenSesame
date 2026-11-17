----------------------- MODULE DeviceAuthorization -----------------------
EXTENDS Naturals

\* One fresh domain session, a monotonic abstract clock, two principals and
\* two recorded polls. Explicit expiry is an administrative action and can
\* occur before the deadline; automatic expiry occurs at or after it. This is
\* not an RFC 8628 issuer, polling protocol, durable-store or concurrency model.

States == {"pending", "approved", "denied", "consumed", "expired"}
Terminal == {"denied", "consumed", "expired"}
Times == {"before", "deadline", "after"}
Actors == {"alice", "bob"}
Actions == {"init", "advance", "approve", "deny", "consume", "expire", "maybe", "poll"}
Results == {"none", "changed", "unchanged", "invalid", "expired-error"}

VARIABLES session, previous, now, action, result, actor
vars == <<session, previous, now, action, result, actor>>

Init ==
  /\ session = [state |-> "pending", id |-> "device", deviceDigest |-> "d1",
                 userDigest |-> "u1", approvedBy |-> "none", polls |-> 0]
  /\ previous = session /\ now = "before" /\ action = "init"
  /\ result = "none" /\ actor = "alice"

Advance ==
  /\ now # "after"
  /\ now' = IF now = "before" THEN "deadline" ELSE "after"
  /\ previous' = session /\ action' = "advance" /\ result' = "unchanged"
  /\ UNCHANGED <<session, actor>>

Allowed(from, target) ==
  (from = "pending" /\ target \in {"approved", "denied", "expired"}) \/
  (from = "approved" /\ target \in {"consumed", "expired"})

Decision(target, person) ==
  /\ target \in {"approved", "denied", "consumed"} /\ person \in Actors
  /\ previous' = session /\ action' = CASE target = "approved" -> "approve"
                                       [] target = "denied" -> "deny"
                                       [] OTHER -> "consume"
  /\ actor' = person
  /\ IF session.state = "expired" \/
        (now # "before" /\ session.state \notin Terminal)
       THEN /\ session' = session /\ result' = "expired-error"
       ELSE IF ~Allowed(session.state, target)
         THEN /\ session' = session /\ result' = "invalid"
         ELSE /\ session' = [session EXCEPT !.state = target,
                            !.approvedBy = IF target = "approved" THEN person ELSE @]
              /\ result' = "changed"
  /\ UNCHANGED now

Expire ==
  /\ previous' = session /\ action' = "expire"
  /\ IF Allowed(session.state, "expired")
       THEN /\ session' = [session EXCEPT !.state = "expired"] /\ result' = "changed"
       ELSE /\ session' = session /\ result' = "invalid"
  /\ UNCHANGED <<now, actor>>

MaybeExpire ==
  /\ previous' = session /\ action' = "maybe"
  /\ IF session.state \notin Terminal /\ now # "before"
       THEN /\ session' = [session EXCEPT !.state = "expired"] /\ result' = "changed"
       ELSE /\ session' = session /\ result' = "unchanged"
  /\ UNCHANGED <<now, actor>>

Poll ==
  /\ session.polls < 2
  /\ previous' = session /\ action' = "poll" /\ result' = "changed"
  /\ session' = [session EXCEPT !.polls = @ + 1]
  /\ UNCHANGED <<now, actor>>

Next == Advance \/ (\E target \in {"approved", "denied", "consumed"},
                         person \in Actors: Decision(target, person)) \/
        Expire \/ MaybeExpire \/ Poll
Spec == Init /\ [][Next]_vars

TypeOK == /\ session.state \in States /\ session.polls \in 0..2
          /\ session.approvedBy \in Actors \cup {"none"}
          /\ now \in Times /\ action \in Actions /\ result \in Results
          /\ actor \in Actors

BindingsPreserved == session.id = "device" /\ session.deviceDigest = "d1" /\ session.userDigest = "u1"
TerminalStateStable == previous.state \in Terminal => session.state = previous.state
NoLateDecision == action \in {"approve", "deny", "consume"} /\ result = "changed" => now = "before"
ConsumptionRequiresApproval == action = "consume" /\ result = "changed" => previous.state = "approved"
ApprovedHasActor == session.state \in {"approved", "consumed"} => session.approvedBy \in Actors
RejectedDoesNotChange == result \in {"invalid", "expired-error"} => session = previous
PollingPreservesState == action = "poll" => session.state = previous.state /\ session.polls = previous.polls + 1
AutomaticExpiryNotEarly == action = "maybe" /\ result = "changed" => now # "before"

\* Negative controls assert reachability by deliberately denying it.
ConsumptionUnreachable == session.state # "consumed"
LateDenialUnreachable == ~(action = "approve" /\ now = "deadline" /\ result = "expired-error")
=============================================================================
