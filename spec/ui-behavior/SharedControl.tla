-------------------------- MODULE SharedControl --------------------------
\* A controlled switch requests a change; its caller can reject that request.
\* A disabled fieldset prevents requests. No authorization or I/O is modeled.
VARIABLES checked, disabled, allow, before, wasDisabled, wasAllowed, requested,
          activated
vars == <<checked, disabled, allow, before, wasDisabled, wasAllowed, requested,
          activated>>

Init == /\ checked = FALSE
        /\ disabled = FALSE
        /\ allow = TRUE
        /\ before = FALSE
        /\ wasDisabled = FALSE
        /\ wasAllowed = TRUE
        /\ requested = FALSE
        /\ activated = FALSE

ChangeDisabled == /\ disabled' = ~disabled
                  /\ UNCHANGED <<checked, allow, before, wasDisabled,
                                  wasAllowed, requested, activated>>

ChangePermission == /\ allow' = ~allow
                    /\ UNCHANGED <<checked, disabled, before, wasDisabled,
                                    wasAllowed, requested, activated>>

Activate == /\ before' = checked
            /\ wasDisabled' = disabled
            /\ wasAllowed' = allow
            /\ requested' = ~disabled
            /\ activated' = TRUE
            /\ checked' = IF ~disabled /\ allow THEN ~checked ELSE checked
            /\ UNCHANGED <<disabled, allow>>

Next == ChangeDisabled \/ ChangePermission \/ Activate
Spec == Init /\ [][Next]_vars

TypeOK == /\ checked \in BOOLEAN /\ disabled \in BOOLEAN /\ allow \in BOOLEAN
          /\ before \in BOOLEAN /\ wasDisabled \in BOOLEAN
          /\ wasAllowed \in BOOLEAN /\ requested \in BOOLEAN
          /\ activated \in BOOLEAN

DisabledDoesNotRequest == activated /\ wasDisabled => ~requested
RejectedDoesNotChange == activated /\ (~wasAllowed \/ wasDisabled) => checked = before
AcceptedRequestToggles == activated /\ ~wasDisabled /\ wasAllowed =>
                          requested /\ checked = ~before
=============================================================================
