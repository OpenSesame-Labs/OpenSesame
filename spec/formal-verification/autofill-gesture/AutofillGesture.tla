---------------------------- MODULE AutofillGesture ----------------------------
EXTENDS Naturals
\* browser-extension-autofill decideFill: fill only with extension gesture.

VARIABLES gesture, topFrame, originOn, entryMatch, askValue, writeValue

vars == <<gesture, topFrame, originOn, entryMatch, askValue, writeValue>>

Init ==
  /\ gesture = FALSE
  /\ topFrame = TRUE
  /\ originOn = TRUE
  /\ entryMatch = TRUE
  /\ askValue = FALSE
  /\ writeValue = FALSE

ExtensionGesture ==
  /\ gesture' = TRUE
  /\ UNCHANGED <<topFrame, originOn, entryMatch, askValue, writeValue>>

PageGesture ==
  /\ gesture' = FALSE
  /\ askValue' = FALSE
  /\ writeValue' = FALSE
  /\ UNCHANGED <<topFrame, originOn, entryMatch>>

DecideFill ==
  /\ IF /\ gesture /\ topFrame /\ originOn /\ entryMatch
     THEN /\ askValue' = TRUE
          /\ writeValue' = TRUE
     ELSE /\ askValue' = FALSE
          /\ writeValue' = FALSE
  /\ UNCHANGED <<gesture, topFrame, originOn, entryMatch>>

NoFillWithoutGesture == ~gesture => ~askValue /\ ~writeValue

Spec == Init /\ [][ExtensionGesture \/ PageGesture \/ DecideFill]_vars

====