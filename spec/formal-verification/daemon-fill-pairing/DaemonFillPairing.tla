---------------------------- MODULE DaemonFillPairing ----------------------------
EXTENDS Naturals
\* fill_value and match refuse before approvals when the caller is not paired.

VARIABLES paired, approved, released

vars == <<paired, approved, released>>

Init ==
  /\ paired = FALSE
  /\ approved = FALSE
  /\ released = FALSE

Pair ==
  /\ paired' = TRUE
  /\ UNCHANGED <<approved, released>>

Approve ==
  /\ paired
  /\ approved' = TRUE
  /\ UNCHANGED <<paired, released>>

FillRequest ==
  /\ IF paired /\ approved
     THEN released' = TRUE
     ELSE released' = FALSE
  /\ UNCHANGED <<paired, approved>>

NoFillWithoutPairing == released => (paired /\ approved)

Spec == Init /\ [][Pair \/ Approve \/ FillRequest]_vars

====