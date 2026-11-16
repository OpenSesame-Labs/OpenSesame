--------------------------- MODULE ConnectorModes ---------------------------
EXTENDS Naturals

\* A deliberately small model of the pilot chooser. It specifies one selected
\* method, a group lock, and an option that is always unavailable.
Methods == {"app", "token"}
Attempts == Methods \cup {"unavailable"}

VARIABLES selected, locked, before, wasLocked, attempted
vars == <<selected, locked, before, wasLocked, attempted>>

Init == /\ selected = "app"
        /\ locked = FALSE
        /\ before = selected
        /\ wasLocked = locked
        /\ attempted = "none"

Toggle == /\ locked' = ~locked
          /\ UNCHANGED <<selected, before, wasLocked, attempted>>

Select(method) ==
  /\ method \in Attempts
  /\ before' = selected
  /\ wasLocked' = locked
  /\ attempted' = method
  /\ selected' = IF ~locked /\ method \in Methods THEN method ELSE selected
  /\ UNCHANGED locked

Next == Toggle \/ (\E method \in Attempts: Select(method))
Spec == Init /\ [][Next]_vars

TypeOK == /\ selected \in Methods
          /\ locked \in BOOLEAN
          /\ before \in Methods
          /\ wasLocked \in BOOLEAN
          /\ attempted \in Attempts \cup {"none"}

BlockedSelectionDoesNotChange ==
  (wasLocked \/ attempted = "unavailable") => selected = before

AllowedSelectionTakesEffect ==
  (~wasLocked /\ attempted \in Methods) => selected = attempted
=============================================================================
