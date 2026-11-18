--------------------------- MODULE RovingTabs ---------------------------
EXTENDS Naturals

\* A stable nonempty tablist with all tabs mounted and enabled. Focus may be
\* moved externally before a key is sent. The parent accepts every selection
\* request synchronously. Dynamic removal, disabled tabs, browser event
\* delivery and assistive technology are outside this finite model.

Keys == {"left", "right", "home", "end", "other"}
Actions == Keys \cup {"init", "focus"}

VARIABLES count, selected, focus, previousSelected, previousFocus, action, prevented
vars == <<count, selected, focus, previousSelected, previousFocus, action, prevented>>

Init == /\ count \in 1..4 /\ selected \in 0..(count - 1) /\ focus = selected
        /\ previousSelected = selected /\ previousFocus = focus
        /\ action = "init" /\ prevented = FALSE

Focus(at) ==
  /\ at \in 0..(count - 1)
  /\ previousSelected' = selected /\ previousFocus' = focus
  /\ focus' = at /\ action' = "focus" /\ prevented' = FALSE
  /\ UNCHANGED <<count, selected>>

Move(key) ==
  /\ key \in Keys
  /\ previousSelected' = selected /\ previousFocus' = focus /\ action' = key
  /\ IF key = "other"
       THEN /\ selected' = selected /\ focus' = focus /\ prevented' = FALSE
       ELSE /\ selected' = CASE key = "left" -> IF focus = 0 THEN count - 1 ELSE focus - 1
                              [] key = "right" -> IF focus = count - 1 THEN 0 ELSE focus + 1
                              [] key = "home" -> 0
                              [] OTHER -> count - 1
            /\ focus' = selected' /\ prevented' = TRUE
  /\ UNCHANGED count

Next == (\E at \in 0..(count - 1): Focus(at)) \/ (\E key \in Keys: Move(key))
Spec == Init /\ [][Next]_vars

TypeOK == /\ count \in 1..4 /\ selected \in 0..(count - 1) /\ focus \in 0..(count - 1)
          /\ previousSelected \in 0..(count - 1) /\ previousFocus \in 0..(count - 1)
          /\ action \in Actions /\ prevented \in BOOLEAN
RecognizedKeyMovesFocus == action \in Keys \ {"other"} => focus = selected /\ prevented
OtherKeyDoesNothing == action = "other" => selected = previousSelected /\ focus = previousFocus /\ ~prevented
LeftMovesBack == action = "left" => selected = IF previousFocus = 0 THEN count - 1 ELSE previousFocus - 1
RightMovesForward == action = "right" => selected = IF previousFocus = count - 1 THEN 0 ELSE previousFocus + 1
HomeMovesFirst == action = "home" => selected = 0
EndMovesLast == action = "end" => selected = count - 1

\* Deliberately false: the fault test requires the wraparound path to exist.
RightWrapUnreachable == ~(count > 1 /\ action = "right" /\ previousFocus = count - 1 /\ selected = 0)
=============================================================================
