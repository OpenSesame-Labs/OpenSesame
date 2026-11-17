------------------------ MODULE NativeOidcEvidence ------------------------
EXTENDS Naturals

\* One issued evidence object and one distinct forged object in a single
\* JavaScript agent. Issuance represents a completed verification, not the
\* verification algorithm itself. Consumption is atomic: the real function
\* deletes the WeakMap entry before calling the owner or checking expiry.
\* Owner retirement and expiry are monotonic in this model. No cross-agent
\* sharing, persistence, garbage collection, clock rollback, token claims,
\* cryptography, or local-admission side effects are represented.

Subjects == {"genuine", "forged"}
Actions == {"init", "issue", "consume", "retire", "expire"}
Results == {"none", "accepted", "rejected"}

VARIABLES issued, present, spent, current, fresh, successes,
          action, subject, result, wasPresent, wasCurrent, wasFresh
vars == <<issued, present, spent, current, fresh, successes,
          action, subject, result, wasPresent, wasCurrent, wasFresh>>

Init == /\ issued = FALSE /\ present = FALSE /\ spent = FALSE
        /\ current = TRUE /\ fresh = TRUE /\ successes = 0
        /\ action = "init" /\ subject = "forged" /\ result = "none"
        /\ wasPresent = FALSE /\ wasCurrent = TRUE /\ wasFresh = TRUE

Issue ==
  /\ ~issued /\ current /\ fresh
  /\ issued' = TRUE /\ present' = TRUE /\ action' = "issue"
  /\ UNCHANGED <<spent, current, fresh, successes, subject, result,
                 wasPresent, wasCurrent, wasFresh>>

Consume(who) ==
  /\ who \in Subjects
  /\ who = "forged" \/ issued
  /\ action' = "consume" /\ subject' = who
  /\ wasPresent' = present
  /\ wasCurrent' = current /\ wasFresh' = fresh
  /\ present' = IF who = "genuine" THEN FALSE ELSE present
  /\ spent' = (spent \/ (who = "genuine" /\ wasPresent'))
  /\ result' = IF who = "genuine" /\ wasPresent' /\ current /\ fresh
                 THEN "accepted" ELSE "rejected"
  /\ successes' = IF result' = "accepted" THEN successes + 1 ELSE successes
  /\ UNCHANGED <<issued, current, fresh>>

Retire == /\ current /\ current' = FALSE /\ action' = "retire"
          /\ UNCHANGED <<issued, present, spent, fresh, successes, subject,
                         result, wasPresent, wasCurrent, wasFresh>>
Expire == /\ fresh /\ fresh' = FALSE /\ action' = "expire"
          /\ UNCHANGED <<issued, present, spent, current, successes, subject,
                         result, wasPresent, wasCurrent, wasFresh>>

Next == Issue \/ (\E who \in Subjects: Consume(who)) \/ Retire \/ Expire
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(Consume("genuine"))

TypeOK == /\ issued \in BOOLEAN /\ present \in BOOLEAN /\ spent \in BOOLEAN
          /\ current \in BOOLEAN /\ fresh \in BOOLEAN /\ successes \in 0..1
          /\ action \in Actions /\ subject \in Subjects /\ result \in Results
          /\ wasPresent \in BOOLEAN /\ wasCurrent \in BOOLEAN
          /\ wasFresh \in BOOLEAN

AtMostOneSuccess == successes <= 1
SpentNeverReappears == spent => issued /\ ~present
AcceptanceRequiresLiveEvidence ==
  action = "consume" /\ result = "accepted" =>
    subject = "genuine" /\ wasPresent /\ wasCurrent /\ wasFresh
ForgedDoesNotConsumeGenuine ==
  action = "consume" /\ subject = "forged" =>
    result = "rejected" /\ present = wasPresent
GenuineAttemptConsumes ==
  action = "consume" /\ subject = "genuine" => ~present

\* Liveness is conditional: if a real consume attempt remains enabled, weak
\* fairness requires it eventually to occur. Without that assumption callers
\* may leave evidence unused indefinitely.
EventuallyConsumed == [](issued => <> ~present)

\* Deliberately false reachability checks used by the negative-control test.
SuccessUnreachable == successes = 0
InvalidConsumptionUnreachable ==
  ~(action = "consume" /\ subject = "genuine" /\ wasPresent /\
    (~wasCurrent \/ ~wasFresh) /\ result = "rejected")
=============================================================================
