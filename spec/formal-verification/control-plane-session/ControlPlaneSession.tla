---------------------------- MODULE ControlPlaneSession ----------------------------
EXTENDS Naturals
\* resolveProvisionalSession rejects revoked and expired leases.

VARIABLES revoked, expired, resolves

vars == <<revoked, expired, resolves>>

Init ==
  /\ revoked = FALSE
  /\ expired = FALSE
  /\ resolves = FALSE

Revoke ==
  /\ revoked' = TRUE
  /\ resolves' = FALSE
  /\ UNCHANGED expired

Expire ==
  /\ expired' = TRUE
  /\ resolves' = FALSE
  /\ UNCHANGED revoked

Authenticate ==
  /\ IF revoked \/ expired
     THEN resolves' = FALSE
     ELSE resolves' = TRUE
  /\ UNCHANGED <<revoked, expired>>

NoZombieSession == (revoked \/ expired) => ~resolves

Spec == Init /\ [][Revoke \/ Expire \/ Authenticate]_vars

====