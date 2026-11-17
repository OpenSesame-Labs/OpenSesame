---------------------- MODULE PasskeyCredentialRace ----------------------
EXTENDS Naturals, FiniteSets

\* One credential ID, two verification attempts, and at most one replacement.
\* Registration generations are assumed unique, and store operations atomic.
\* Cryptography is an external Boolean; success is checked at the atomic
\* confirmation, not a promise of revocation after that confirmation.

Callers == {"first", "second"}
Owners == {"alice", "bob"}
Phases == {"idle", "checking", "accepted", "rejected"}
Counters == {"absent", "zero", "one"}

VARIABLES present, generation, owner, counter, phase, readGeneration,
          readOwner, finishGeneration, acceptedLive, acceptedCounter, removalAuthorized, action
vars == <<present, generation, owner, counter, phase, readGeneration,
          readOwner, finishGeneration, acceptedLive, acceptedCounter, removalAuthorized, action>>

Init == /\ present = TRUE /\ generation = 1 /\ owner = "alice" /\ counter = 0
        /\ phase = [c \in Callers |-> "idle"]
        /\ readGeneration = [c \in Callers |-> 1]
        /\ readOwner = [c \in Callers |-> "alice"]
        /\ finishGeneration = [c \in Callers |-> 1]
        /\ acceptedLive = [c \in Callers |-> TRUE]
        /\ acceptedCounter = [c \in Callers |-> "absent"]
        /\ removalAuthorized = TRUE /\ action = "init"

Begin(c) ==
  /\ phase[c] = "idle" /\ present
  /\ phase' = [phase EXCEPT ![c] = "checking"]
  /\ readGeneration' = [readGeneration EXCEPT ![c] = generation]
  /\ readOwner' = [readOwner EXCEPT ![c] = owner]
  /\ action' = "begin"
  /\ UNCHANGED <<present, generation, owner, counter, finishGeneration, acceptedLive,
                 acceptedCounter, removalAuthorized>>

Finish(c, nextCounter, valid) ==
  /\ phase[c] = "checking" /\ nextCounter \in Counters /\ valid \in BOOLEAN
  /\ LET current == present /\ generation = readGeneration[c]
         acceptable == nextCounter = "absent" \/
                       (nextCounter = "zero" /\ counter = 0) \/
                       (nextCounter = "one" /\ counter < 1)
         success == valid /\ current /\ acceptable
     IN /\ phase' = [phase EXCEPT ![c] = IF success THEN "accepted" ELSE "rejected"]
        /\ acceptedLive' = [acceptedLive EXCEPT ![c] =
             IF success THEN present /\ generation = readGeneration[c] /\ owner = readOwner[c]
             ELSE @]
        /\ acceptedCounter' = [acceptedCounter EXCEPT ![c] =
             IF success THEN nextCounter ELSE @]
        /\ finishGeneration' = [finishGeneration EXCEPT ![c] = generation]
        /\ counter' = IF success /\ nextCounter = "one" THEN 1 ELSE counter
  /\ action' = "finish"
  /\ UNCHANGED <<present, generation, owner, readGeneration, readOwner,
                 removalAuthorized>>

Remove(person) ==
  /\ present /\ person = owner
  /\ present' = FALSE /\ removalAuthorized' = (person = owner)
  /\ action' = "remove"
  /\ UNCHANGED <<generation, owner, counter, phase, readGeneration, readOwner,
                 finishGeneration, acceptedLive, acceptedCounter>>

Register(person) ==
  /\ ~present /\ generation = 1
  /\ present' = TRUE /\ generation' = 2 /\ owner' = person /\ counter' = 0
  /\ action' = "register"
  /\ UNCHANGED <<phase, readGeneration, readOwner, finishGeneration, acceptedLive,
                 acceptedCounter, removalAuthorized>>

Next == (\E c \in Callers: Begin(c)) \/
        (\E c \in Callers, n \in Counters, valid \in BOOLEAN: Finish(c, n, valid)) \/
        (\E person \in Owners: Remove(person) \/ Register(person))
Spec == Init /\ [][Next]_vars

TypeOK == /\ present \in BOOLEAN /\ generation \in {1, 2} /\ owner \in Owners
          /\ counter \in {0, 1} /\ phase \in [Callers -> Phases]
          /\ readGeneration \in [Callers -> {1, 2}]
          /\ readOwner \in [Callers -> Owners]
          /\ finishGeneration \in [Callers -> {1, 2}]
          /\ acceptedLive \in [Callers -> BOOLEAN]
          /\ acceptedCounter \in [Callers -> Counters]
          /\ removalAuthorized \in BOOLEAN
          /\ action \in {"init", "begin", "finish", "remove", "register"}

AcceptedLiveAtConfirmation ==
  \A c \in Callers: phase[c] = "accepted" => acceptedLive[c]
RemovalWasAuthorized == removalAuthorized
PositiveCounterSpentOncePerGeneration ==
  \A a, b \in Callers: (a # b /\ phase[a] = "accepted" /\ phase[b] = "accepted" /\
    acceptedCounter[a] = "one" /\ acceptedCounter[b] = "one") =>
    readGeneration[a] # readGeneration[b]

\* Reachability controls for the fault tests.
AcceptanceUnreachable == \A c \in Callers: phase[c] # "accepted"
ReplacementRejectionUnreachable ==
  ~(\E c \in Callers: readGeneration[c] = 1 /\ finishGeneration[c] = 2 /\ phase[c] = "rejected")
=============================================================================
