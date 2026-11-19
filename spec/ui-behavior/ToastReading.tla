--------------------------- MODULE ToastReading ---------------------------
EXTENDS Naturals

\* A finite abstraction of one transient notification's lifetime. A tick is
\* one unit of time actually available to its timer, not a JavaScript event
\* loop or wall-clock model. Hover and keyboard focus independently hold it.
\* Only one toast and no animation, tray persistence, screen-reader output,
\* browser event ordering, or UI layout are modeled.

MaxTicks == 3
Actions == {"initial", "show", "update", "pointer-enter", "pointer-leave",
            "focus-enter", "focus-leave", "tick", "dismiss"}

VARIABLES visible, hover, focused, remaining, previous, action
vars == <<visible, hover, focused, remaining, previous, action>>
Snapshot == [visible |-> visible, hover |-> hover,
             focused |-> focused, remaining |-> remaining]

Init ==
  /\ visible = FALSE
  /\ hover = FALSE
  /\ focused = FALSE
  /\ remaining = 0
  /\ previous = Snapshot
  /\ action = "initial"

Show ==
  /\ ~visible
  /\ previous' = Snapshot
  /\ visible' = TRUE
  /\ hover' = FALSE
  /\ focused' = FALSE
  /\ remaining' = MaxTicks
  /\ action' = "show"

\* New words on the same card receive a full interval, without moving focus.
Update ==
  /\ visible
  /\ previous' = Snapshot
  /\ remaining' = MaxTicks
  /\ action' = "update"
  /\ UNCHANGED <<visible, hover, focused>>

Pointer(value) ==
  /\ visible
  /\ value \in BOOLEAN
  /\ previous' = Snapshot
  /\ hover' = value
  /\ action' = IF value THEN "pointer-enter" ELSE "pointer-leave"
  /\ UNCHANGED <<visible, focused, remaining>>

Focus(value) ==
  /\ visible
  /\ value \in BOOLEAN
  /\ previous' = Snapshot
  /\ focused' = value
  /\ action' = IF value THEN "focus-enter" ELSE "focus-leave"
  /\ UNCHANGED <<visible, hover, remaining>>

Tick ==
  /\ visible
  /\ previous' = Snapshot
  /\ action' = "tick"
  /\ IF hover \/ focused
       THEN UNCHANGED <<visible, hover, focused, remaining>>
       ELSE /\ remaining' = remaining - 1
            /\ visible' = (remaining > 1)
            /\ hover' = FALSE
            /\ focused' = FALSE

Dismiss ==
  /\ visible
  /\ previous' = Snapshot
  /\ visible' = FALSE
  /\ hover' = FALSE
  /\ focused' = FALSE
  /\ action' = "dismiss"
  /\ UNCHANGED remaining

Next == Show \/ Update \/ (\E value \in BOOLEAN: Pointer(value) \/ Focus(value))
        \/ Tick \/ Dismiss
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ visible \in BOOLEAN
  /\ hover \in BOOLEAN
  /\ focused \in BOOLEAN
  /\ remaining \in 0..MaxTicks
  /\ action \in Actions
  /\ visible => remaining > 0
  /\ ~visible => ~hover /\ ~focused

ReadingHoldsTime ==
  action = "tick" /\ (previous.hover \/ previous.focused) =>
    visible /\ remaining = previous.remaining

UpdateRestartsTime ==
  action = "update" =>
    visible /\ remaining = MaxTicks /\ hover = previous.hover /\
      focused = previous.focused

PointerLeaveKeepsFocused ==
  action = "pointer-leave" /\ previous.focused =>
    visible /\ focused /\ remaining = previous.remaining

FocusLeaveKeepsHovered ==
  action = "focus-leave" /\ previous.hover =>
    visible /\ hover /\ remaining = previous.remaining

TimeDecreasesOnlyWhenIdle ==
  remaining < previous.remaining =>
    action = "tick" /\ ~previous.hover /\ ~previous.focused

DisappearanceHasCause ==
  previous.visible /\ ~visible =>
    action = "dismiss" \/
      (action = "tick" /\ previous.remaining = 1 /\
       ~previous.hover /\ ~previous.focused)

DismissCloses == action = "dismiss" => ~visible
=============================================================================
