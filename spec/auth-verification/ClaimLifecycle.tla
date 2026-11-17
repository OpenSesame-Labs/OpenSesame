-------------------------- MODULE ClaimLifecycle --------------------------
EXTENDS Naturals

\* One fresh domain claim, a monotonic clock and at most four successful
\* version increments. An empty completion identifier is rejected; the domain
\* function does not authenticate its caller. Token verification, actor
\* authority, manifest contents, external mutation and persistence races are
\* outside this model. Explicit revoke/expiry can occur before the deadline.

States == {"pending", "presented", "authenticated", "reviewed", "completed", "denied", "revoked", "expired"}
Terminal == {"completed", "denied", "revoked", "expired"}
Times == {"before", "deadline", "after"}
Actors == {"", "alice", "bob"}
Actions == {"init", "advance", "present", "authenticate", "review", "complete", "deny", "revoke", "expire", "maybe"}
Results == {"none", "changed", "unchanged", "invalid", "expired-error", "invariant-error"}

VARIABLES claim, previous, now, action, result, actor
vars == <<claim, previous, now, action, result, actor>>

Init ==
  /\ claim = [state |-> "pending", id |-> "claim", manifestDigest |-> "manifest",
               tokenDigest |-> "token", completedBy |-> "none", version |-> 0]
  /\ previous = claim /\ now = "before" /\ action = "init" /\ result = "none" /\ actor = ""

Advance ==
  /\ now # "after"
  /\ now' = IF now = "before" THEN "deadline" ELSE "after"
  /\ previous' = claim /\ action' = "advance" /\ result' = "unchanged"
  /\ UNCHANGED <<claim, actor>>

Allowed(from, target) ==
  (from = "pending" /\ target \in {"presented", "revoked", "expired"}) \/
  (from = "presented" /\ target \in {"authenticated", "revoked", "expired"}) \/
  (from = "authenticated" /\ target \in {"reviewed", "revoked", "expired"}) \/
  (from = "reviewed" /\ target \in {"completed", "denied", "revoked", "expired"})

Progress(target, person) ==
  /\ claim.version < 4
  /\ target \in {"presented", "authenticated", "reviewed", "completed", "denied"}
  /\ person \in Actors
  /\ previous' = claim /\ actor' = person
  /\ action' = CASE target = "presented" -> "present"
               [] target = "authenticated" -> "authenticate"
               [] target = "reviewed" -> "review"
               [] target = "completed" -> "complete"
               [] OTHER -> "deny"
  /\ IF claim.state = "expired" \/ (now # "before" /\ claim.state \notin Terminal)
       THEN /\ claim' = claim /\ result' = "expired-error"
       ELSE IF ~Allowed(claim.state, target)
         THEN /\ claim' = claim /\ result' = "invalid"
         ELSE IF target = "completed" /\ person = ""
           THEN /\ claim' = claim /\ result' = "invariant-error"
           ELSE /\ claim' = [claim EXCEPT !.state = target, !.version = @ + 1,
                              !.completedBy = IF target = "completed" THEN person ELSE @]
                /\ result' = "changed"
  /\ UNCHANGED now

End(target) ==
  /\ claim.version < 4 /\ target \in {"revoked", "expired"}
  /\ previous' = claim /\ action' = IF target = "revoked" THEN "revoke" ELSE "expire"
  /\ actor' = ""
  /\ IF Allowed(claim.state, target)
       THEN /\ claim' = [claim EXCEPT !.state = target, !.version = @ + 1]
            /\ result' = "changed"
       ELSE /\ claim' = claim /\ result' = "invalid"
  /\ UNCHANGED now

MaybeExpire ==
  /\ claim.version < 4
  /\ previous' = claim /\ action' = "maybe" /\ actor' = ""
  /\ IF claim.state \notin Terminal /\ now # "before"
       THEN /\ claim' = [claim EXCEPT !.state = "expired", !.version = @ + 1]
            /\ result' = "changed"
       ELSE /\ claim' = claim /\ result' = "unchanged"
  /\ UNCHANGED now

Next == Advance \/
        (\E target \in {"presented", "authenticated", "reviewed", "completed", "denied"},
            person \in Actors: Progress(target, person)) \/
        (\E target \in {"revoked", "expired"}: End(target)) \/ MaybeExpire
Spec == Init /\ [][Next]_vars

TypeOK == /\ claim.state \in States /\ claim.version \in 0..4
          /\ claim.completedBy \in Actors \cup {"none"}
          /\ now \in Times /\ action \in Actions /\ result \in Results /\ actor \in Actors
BindingsPreserved == claim.id = "claim" /\ claim.manifestDigest = "manifest" /\ claim.tokenDigest = "token"
TerminalNeverChanges == previous.state \in Terminal => claim = previous
VersionTracksChange == claim.version = previous.version + IF result = "changed" THEN 1 ELSE 0
RejectedDoesNotChange == result \in {"invalid", "expired-error", "invariant-error", "unchanged"} => claim = previous
NoLateProgress == action \in {"present", "authenticate", "review", "complete", "deny"} /\ result = "changed" => now = "before"
CompletionRequiresReview == action = "complete" /\ result = "changed" => previous.state = "reviewed" /\ actor # "" /\ claim.completedBy = actor
DenialRequiresReview == action = "deny" /\ result = "changed" => previous.state = "reviewed"
AutomaticExpiryNotEarly == action = "maybe" /\ result = "changed" => now # "before"

CompletionUnreachable == claim.state # "completed"
DeadlineDenialUnreachable == ~(action = "present" /\ now = "deadline" /\ result = "expired-error")
=============================================================================
