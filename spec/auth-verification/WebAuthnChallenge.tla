------------------------ MODULE WebAuthnChallenge ------------------------
EXTENDS Naturals, FiniteSets

\* One challenge value and two competing assertion attempts in one process.
\* Issuance happens at most once, so collision resistance and reuse of a value
\* across issuances are assumptions. A successful consume is a snapshot at
\* its read time. The signature check is an external Boolean fact. This does
\* not model registration attestation, transaction digests, authenticator
\* counters, origin/RP checks, distributed stores, or proof of cryptography.

Callers == {"first", "second"}
Purposes == {"authentication", "transaction", "registration"}
Allowed == {"authentication", "transaction"}
Principals == {"unbound", "alice", "bob"}
Times == {"before", "deadline", "after"}
Phases == {"idle", "checking", "accepted", "denied"}

VARIABLES issued, present, spent, purpose, principal, now, phase, observed,
          readTime, requested, actor, signature, action
vars == <<issued, present, spent, purpose, principal, now, phase, observed,
          readTime, requested, actor, signature, action>>

Init == /\ issued = FALSE /\ present = FALSE /\ spent = FALSE
        /\ purpose = "authentication" /\ principal = "unbound" /\ now = "before"
        /\ phase = [caller \in Callers |-> "idle"]
        /\ observed = [caller \in Callers |-> FALSE]
        /\ readTime = [caller \in Callers |-> "before"]
        /\ requested = [caller \in Callers |-> "authentication"]
        /\ actor = [caller \in Callers |-> "alice"]
        /\ signature = [caller \in Callers |-> FALSE]
        /\ action = "init"

Issue(p, owner) ==
  /\ ~issued /\ p \in Purposes /\ owner \in Principals
  /\ issued' = TRUE /\ present' = TRUE /\ purpose' = p /\ principal' = owner
  /\ action' = "issue"
  /\ UNCHANGED <<spent, now, phase, observed, readTime, requested, actor, signature>>

Advance ==
  /\ now # "after"
  /\ now' = IF now = "before" THEN "deadline" ELSE "after"
  /\ action' = "advance"
  /\ UNCHANGED <<issued, present, spent, purpose, principal, phase, observed,
                 readTime, requested, actor, signature>>

Begin(caller) ==
  /\ caller \in Callers /\ phase[caller] = "idle"
  /\ observed' = [observed EXCEPT ![caller] = (present /\ now # "after")]
  /\ readTime' = [readTime EXCEPT ![caller] = now]
  /\ spent' = (spent \/ present)
  /\ present' = FALSE
  /\ phase' = [phase EXCEPT ![caller] = "checking"]
  /\ action' = "begin"
  /\ UNCHANGED <<issued, purpose, principal, now, requested, actor, signature>>

Finish(caller, requestedPurpose, person, validSignature) ==
  /\ caller \in Callers /\ phase[caller] = "checking"
  /\ requestedPurpose \in Purposes /\ person \in {"alice", "bob"}
  /\ validSignature \in BOOLEAN
  /\ requested' = [requested EXCEPT ![caller] = requestedPurpose]
  /\ actor' = [actor EXCEPT ![caller] = person]
  /\ signature' = [signature EXCEPT ![caller] = validSignature]
  /\ phase' = [phase EXCEPT ![caller] =
       IF observed[caller] /\ requestedPurpose \in Allowed /\
          requestedPurpose = purpose /\
          (principal = "unbound" \/ principal = person) /\ validSignature
       THEN "accepted" ELSE "denied"]
  /\ action' = "finish"
  /\ UNCHANGED <<issued, present, spent, purpose, principal, now, observed, readTime>>

Next == (\E p \in Purposes, owner \in Principals: Issue(p, owner)) \/ Advance \/
        (\E caller \in Callers: Begin(caller)) \/
        (\E caller \in Callers, p \in Purposes, person \in {"alice", "bob"},
            valid \in BOOLEAN: Finish(caller, p, person, valid))
Spec == Init /\ [][Next]_vars

TypeOK == /\ issued \in BOOLEAN /\ present \in BOOLEAN /\ spent \in BOOLEAN
          /\ purpose \in Purposes /\ principal \in Principals /\ now \in Times
          /\ phase \in [Callers -> Phases] /\ observed \in [Callers -> BOOLEAN]
          /\ readTime \in [Callers -> Times] /\ requested \in [Callers -> Purposes]
          /\ actor \in [Callers -> {"alice", "bob"}]
          /\ signature \in [Callers -> BOOLEAN]
          /\ action \in {"init", "issue", "advance", "begin", "finish"}

SpentCannotReappear == spent => issued /\ ~present
AtMostOneAcceptance == Cardinality({c \in Callers: phase[c] = "accepted"}) <= 1
AcceptedWasLiveAtRead ==
  \A c \in Callers: phase[c] = "accepted" => observed[c] /\ readTime[c] # "after"
AcceptedPurposeMatches ==
  \A c \in Callers: phase[c] = "accepted" => requested[c] \in Allowed /\ requested[c] = purpose
AcceptedPrincipalMatches ==
  \A c \in Callers: phase[c] = "accepted" => principal = "unbound" \/ principal = actor[c]
AcceptedSignatureValid ==
  \A c \in Callers: phase[c] = "accepted" => signature[c]

\* Deliberately false reachability claims for negative-control tests.
AcceptanceUnreachable == \A c \in Callers: phase[c] # "accepted"
RegistrationDenialUnreachable ==
  ~(purpose = "registration" /\ \E c \in Callers: phase[c] = "denied" /\ observed[c])
=============================================================================
