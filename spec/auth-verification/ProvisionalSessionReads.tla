----------------------- MODULE ProvisionalSessionReads -----------------------
\* One access-token resolution with atomic store reads and irreversible
\* invalidation. A successful read is a snapshot: an in-flight request does
\* not re-read the token, session or principal before returning. This model
\* does not claim that the real stores are linearizable or return snapshots.

VARIABLES phase, prefix, token, session, expired, revoked, eligible,
          readToken, readSession, readPrincipal, goodAtStart

vars == <<phase, prefix, token, session, expired, revoked, eligible,
          readToken, readSession, readPrincipal, goodAtStart>>
environment == <<token, session, expired, revoked, eligible>>
observations == <<phase, prefix, readToken, readSession, readPrincipal, goodAtStart>>
running == {"idle", "token", "session", "principal", "return"}

Init == /\ phase = "idle" /\ prefix = FALSE
        /\ token = TRUE /\ session = TRUE /\ expired = FALSE
        /\ revoked = FALSE /\ eligible = TRUE
        /\ readToken = FALSE /\ readSession = FALSE /\ readPrincipal = FALSE
        /\ goodAtStart = FALSE

Start(p) ==
  /\ phase = "idle" /\ p \in BOOLEAN
  /\ prefix' = p
  /\ goodAtStart' = (token /\ session /\ ~expired /\ ~revoked /\ eligible)
  /\ phase' = IF p THEN "token" ELSE "denied"
  /\ UNCHANGED <<environment, readToken, readSession, readPrincipal>>

ReadToken ==
  /\ phase = "token"
  /\ readToken' = token
  /\ phase' = IF token THEN "session" ELSE "denied"
  /\ UNCHANGED <<environment, prefix, readSession, readPrincipal, goodAtStart>>

ReadSession ==
  /\ phase = "session"
  /\ readSession' = (session /\ ~expired /\ ~revoked)
  /\ phase' = IF readSession' THEN "principal" ELSE "denied"
  /\ UNCHANGED <<environment, prefix, readToken, readPrincipal, goodAtStart>>

ReadPrincipal ==
  /\ phase = "principal"
  /\ readPrincipal' = eligible
  /\ phase' = IF eligible THEN "return" ELSE "denied"
  /\ UNCHANGED <<environment, prefix, readToken, readSession, goodAtStart>>

Return == /\ phase = "return" /\ phase' = "accepted"
          /\ UNCHANGED <<environment, prefix, readToken, readSession,
                         readPrincipal, goodAtStart>>

DropToken == /\ phase \in running /\ token /\ token' = FALSE
             /\ UNCHANGED <<observations, session, expired, revoked, eligible>>
DropSession == /\ phase \in running /\ session /\ session' = FALSE
               /\ UNCHANGED <<observations, token, expired, revoked, eligible>>
Expire == /\ phase \in running /\ ~expired /\ expired' = TRUE
          /\ UNCHANGED <<observations, token, session, revoked, eligible>>
Revoke == /\ phase \in running /\ ~revoked /\ revoked' = TRUE
          /\ UNCHANGED <<observations, token, session, expired, eligible>>
Suspend == /\ phase \in running /\ eligible /\ eligible' = FALSE
           /\ UNCHANGED <<observations, token, session, expired, revoked>>

Next == (\E p \in BOOLEAN: Start(p)) \/ ReadToken \/ ReadSession \/
        ReadPrincipal \/ Return \/ DropToken \/ DropSession \/ Expire \/
        Revoke \/ Suspend
Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in {"idle", "token", "session", "principal", "return", "accepted", "denied"}
          /\ prefix \in BOOLEAN /\ token \in BOOLEAN /\ session \in BOOLEAN
          /\ expired \in BOOLEAN /\ revoked \in BOOLEAN /\ eligible \in BOOLEAN
          /\ readToken \in BOOLEAN /\ readSession \in BOOLEAN
          /\ readPrincipal \in BOOLEAN /\ goodAtStart \in BOOLEAN

AcceptedUsesEligibleReads ==
  phase = "accepted" => prefix /\ readToken /\ readSession /\ readPrincipal

InvalidAtStartCannotAuthenticate == phase = "accepted" => goodAtStart

BadPrefixNeverReads == ~prefix => ~readToken /\ ~readSession /\ ~readPrincipal

\* This deliberately stronger candidate is NOT an invariant: revocation can
\* happen after ReadSession and before Return. A negative check exhibits it.
AcceptedRequiresCurrentRevocationCheck == phase = "accepted" => ~revoked

\* Reachability controls: these deliberately false candidates ensure the
\* passing safety invariants do not hold merely because attempts cannot start
\* or a revoked session read cannot complete.
RevokedSessionDenialUnreachable ==
  ~(phase = "denied" /\ prefix /\ readToken /\ ~readSession /\ revoked)
InvalidStartDenialUnreachable == ~(phase = "denied" /\ prefix /\ ~goodAtStart)
=============================================================================
