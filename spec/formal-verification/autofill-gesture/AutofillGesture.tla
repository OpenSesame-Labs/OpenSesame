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

NotTopFrame ==
  /\ topFrame' = FALSE
  /\ UNCHANGED <<gesture, originOn, entryMatch, askValue, writeValue>>

OriginOff ==
  /\ originOn' = FALSE
  /\ UNCHANGED <<gesture, topFrame, entryMatch, askValue, writeValue>>

EntryMismatch ==
  /\ entryMatch' = FALSE
  /\ UNCHANGED <<gesture, topFrame, originOn, askValue, writeValue>>

DecideFill ==
  /\ IF /\ gesture /\ topFrame /\ originOn /\ entryMatch
     THEN /\ askValue' = TRUE
          /\ writeValue' = TRUE
     ELSE /\ askValue' = FALSE
          /\ writeValue' = FALSE
  /\ UNCHANGED <<gesture, topFrame, originOn, entryMatch>>

NoFillWithoutGesture == ~gesture => ~askValue /\ ~writeValue
NoFillWithoutTopFrame == ~topFrame => ~askValue /\ ~writeValue
NoFillWithoutOrigin == ~originOn => ~askValue /\ ~writeValue
NoFillWithoutEntryMatch == ~entryMatch => ~askValue /\ ~writeValue

Spec == Init /\ [][ExtensionGesture \/ PageGesture \/ NotTopFrame \/ OriginOff \/ EntryMismatch \/ DecideFill]_vars

====