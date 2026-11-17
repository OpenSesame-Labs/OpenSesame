------------------------ MODULE GitHubConnection ------------------------
\* Finite abstraction of the browser-local GitHub App backup target.
\* "confirmed" means locally recorded successful sync with no pending/error;
\* it does not model credentials, remote state, I/O, or the UI's first-write
\* approval. The implementation-level property test injects that record.

Bindings == {"alpha", "beta"}
NoBinding == "none"
Choices == {"default", "on", "off"}
Actions == {"init", "configure", "set-enabled", "delete", "confirm", "invalid"}

VARIABLES binding, enabled, confirmed,
          previousBinding, previousEnabled, previousConfirmed,
          lastAction, lastChoice

vars == <<binding, enabled, confirmed, previousBinding, previousEnabled,
          previousConfirmed, lastAction, lastChoice>>

Init == /\ binding = NoBinding
        /\ enabled = FALSE
        /\ confirmed = FALSE
        /\ previousBinding = NoBinding
        /\ previousEnabled = FALSE
        /\ previousConfirmed = FALSE
        /\ lastAction = "init"
        /\ lastChoice = "default"

Record(action) ==
  /\ previousBinding' = binding
  /\ previousEnabled' = enabled
  /\ previousConfirmed' = confirmed
  /\ lastAction' = action

Configure(destination, choice) ==
  /\ destination \in Bindings
  /\ choice \in Choices
  /\ Record("configure")
  /\ lastChoice' = choice
  /\ binding' = destination
  /\ enabled' = CASE choice = "on" -> TRUE
                   [] choice = "off" -> FALSE
                   [] OTHER -> IF binding = NoBinding THEN FALSE ELSE enabled
  /\ confirmed' = IF binding = destination THEN confirmed ELSE FALSE

SetEnabled(value) ==
  /\ value \in BOOLEAN
  /\ Record("set-enabled")
  /\ enabled' = IF binding = NoBinding THEN FALSE ELSE value
  /\ UNCHANGED <<binding, confirmed, lastChoice>>

Delete == /\ Record("delete")
          /\ binding' = NoBinding
          /\ enabled' = FALSE
          /\ confirmed' = FALSE
          /\ UNCHANGED lastChoice

Confirm == /\ binding # NoBinding
           /\ enabled
           /\ Record("confirm")
           /\ confirmed' = TRUE
           /\ UNCHANGED <<binding, enabled, lastChoice>>

InvalidCreate == /\ binding = NoBinding
                 /\ Record("invalid")
                 /\ UNCHANGED <<binding, enabled, confirmed, lastChoice>>

Next == (\E destination \in Bindings, choice \in Choices:
           Configure(destination, choice))
        \/ (\E value \in BOOLEAN: SetEnabled(value))
        \/ Delete \/ Confirm \/ InvalidCreate

Spec == Init /\ [][Next]_vars

TypeOK == /\ binding \in Bindings \cup {NoBinding}
          /\ previousBinding \in Bindings \cup {NoBinding}
          /\ enabled \in BOOLEAN /\ confirmed \in BOOLEAN
          /\ previousEnabled \in BOOLEAN /\ previousConfirmed \in BOOLEAN
          /\ lastAction \in Actions /\ lastChoice \in Choices

MissingBindingIsOff == binding = NoBinding => ~enabled /\ ~confirmed

DefaultCreationIsOff ==
  (lastAction = "configure" /\ previousBinding = NoBinding /\
   lastChoice = "default") => ~enabled

DefaultEditPreservesEnabled ==
  (lastAction = "configure" /\ previousBinding # NoBinding /\
   lastChoice = "default") => enabled = previousEnabled

ChangedBindingClearsConfirmation ==
  (lastAction = "configure" /\ previousBinding # binding) => ~confirmed

SameBindingPreservesConfirmation ==
  (lastAction = "configure" /\ previousBinding = binding) =>
    confirmed = previousConfirmed
=============================================================================
