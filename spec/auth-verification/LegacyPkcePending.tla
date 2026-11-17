----------------------- MODULE LegacyPkcePending -----------------------
\* Finite abstraction of the legacy explicit-sign-in local/session slot.
\* Each storage operation is atomic. Corrupt represents malformed selected
\* data. Expiration is nondeterministic and never reverses until a new write;
\* no claim is made about clocks, randomness, PKCE, tokens, or OAuth itself.

States == {"a", "b"}
None == "none"
Corrupt == "corrupt"
Records == States \cup {None, Corrupt}
Inputs == States \cup {None}
Results == {"none", "accepted", "unmatched", "stale", "absent"}

VARIABLES local, session, localFresh, sessionFresh,
          result, input, selectedBefore, freshBefore, conflictBefore,
          localBefore, sessionBefore, event

vars == <<local, session, localFresh, sessionFresh, result, input,
          selectedBefore, freshBefore, conflictBefore, localBefore,
          sessionBefore, event>>

Init == /\ local = None /\ session = None
        /\ localFresh = FALSE /\ sessionFresh = FALSE
        /\ result = "none" /\ input = None /\ selectedBefore = None
        /\ freshBefore = FALSE /\ conflictBefore = FALSE
        /\ localBefore = None /\ sessionBefore = None /\ event = "init"

Selected == IF local # None THEN local ELSE session
SelectedFresh == IF local # None THEN localFresh ELSE sessionFresh
Conflict == local \in States /\ session \in States /\ local # session

Observe(action) ==
  /\ localBefore' = local /\ sessionBefore' = session
  /\ selectedBefore' = Selected /\ freshBefore' = SelectedFresh
  /\ conflictBefore' = Conflict /\ event' = action
  /\ input' = None /\ result' = "none"

Store(value) ==
  /\ value \in States
  /\ Observe("store")
  /\ local' = value /\ localFresh' = TRUE
  /\ session' = None /\ sessionFresh' = FALSE

WriteSession(value) ==
  /\ value \in States
  /\ Observe("session")
  /\ session' = value /\ sessionFresh' = TRUE
  /\ UNCHANGED <<local, localFresh>>

CorruptLocal ==
  /\ Observe("corrupt")
  /\ local' = Corrupt /\ localFresh' = FALSE
  /\ UNCHANGED <<session, sessionFresh>>

CorruptSession ==
  /\ Observe("corrupt")
  /\ session' = Corrupt /\ sessionFresh' = FALSE
  /\ UNCHANGED <<local, localFresh>>

Expire ==
  /\ Observe("expire")
  /\ localFresh' = FALSE /\ sessionFresh' = FALSE
  /\ UNCHANGED <<local, session>>

Logout ==
  /\ Observe("logout")
  /\ local' = None /\ session' = None
  /\ localFresh' = FALSE /\ sessionFresh' = FALSE

Take(presented) ==
  /\ presented \in Inputs
  /\ localBefore' = local /\ sessionBefore' = session
  /\ selectedBefore' = Selected /\ freshBefore' = SelectedFresh
  /\ conflictBefore' = Conflict /\ event' = "take" /\ input' = presented
  /\ result' =
       IF Conflict THEN "stale"
       ELSE IF Selected = None THEN "absent"
       ELSE IF Selected = Corrupt \/ ~SelectedFresh THEN "stale"
       ELSE IF presented = None \/ presented # Selected THEN "unmatched"
       ELSE "accepted"
  /\ IF result' \in {"accepted", "stale"}
        THEN /\ local' = None /\ session' = None
             /\ localFresh' = FALSE /\ sessionFresh' = FALSE
        ELSE UNCHANGED <<local, session, localFresh, sessionFresh>>

Next == (\E value \in States: Store(value) \/ WriteSession(value))
        \/ (\E presented \in Inputs: Take(presented))
        \/ CorruptLocal \/ CorruptSession \/ Expire \/ Logout
Spec == Init /\ [][Next]_vars

TypeOK == /\ local \in Records /\ session \in Records
          /\ localBefore \in Records /\ sessionBefore \in Records
          /\ localFresh \in BOOLEAN /\ sessionFresh \in BOOLEAN
          /\ freshBefore \in BOOLEAN /\ conflictBefore \in BOOLEAN
          /\ result \in Results /\ input \in Inputs
          /\ selectedBefore \in Records
          /\ event \in {"init", "store", "session", "corrupt", "expire", "logout", "take"}

AcceptedMatchesAndConsumes ==
  result = "accepted" => /\ input = selectedBefore
                         /\ selectedBefore \in States
                         /\ freshBefore /\ ~conflictBefore
                         /\ local = None /\ session = None

UnmatchedDoesNotConsume ==
  result = "unmatched" => /\ local = localBefore
                          /\ session = sessionBefore

ConflictingStoresAreRejected ==
  event = "take" /\ conflictBefore => result = "stale" /\ local = None /\ session = None

StaleOrCorruptCannotBeAccepted ==
  event = "take" /\ selectedBefore # None /\
    (~freshBefore \/ selectedBefore = Corrupt) => result # "accepted"

LogoutClearsSlots == event = "logout" => local = None /\ session = None
=============================================================================
