---------------------------- MODULE PwaShellReady ----------------------------
EXTENDS Naturals
\* apps/pages/src/bindings/shell-ready.ts computeShellReady

CONSTANT MaxGen

VARIABLES
  status,          \* "locked" | "unlocked"
  vault,           \* tomb string when unlocked
  planVault,       \* null or vault id
  compGen,
  actGen,
  opened,          \* 0 = undefined, 1 = null, 2 = matches vault
  timedOut,        \* bounded wait fired
  fromNull         \* this plan replaced a null plan

vars == <<status, vault, planVault, compGen, actGen, opened, timedOut, fromNull>>

OpenedMatchesVault == opened = 2
OpenedUnset == opened = 0

ComputeReady ==
  /\ status = "unlocked"
  /\ \/ planVault = "none"
     \/ /\ planVault = vault
        /\ actGen = compGen

\* Latch from the null-plan window is not a mount once the vault plan is in
\* and activation has not caught up. Later generations stay mounted.
StaleOpenLatch ==
  /\ status = "unlocked"
  /\ planVault = vault
  /\ opened = 2
  /\ actGen < compGen
  /\ ~timedOut
  /\ fromNull

ShellMounted ==
  \/ ComputeReady
  \/ /\ status = "unlocked"
     /\ OpenedMatchesVault
     /\ ~StaleOpenLatch

TypeOK ==
  /\ status \in {"locked", "unlocked"}
  /\ vault \in {"personal", "guest", "none"}
  /\ planVault \in {"none", "personal", "guest", "other"}
  /\ compGen \in 0..MaxGen
  /\ actGen \in 0..MaxGen
  /\ opened \in {0, 1, 2}
  /\ timedOut \in BOOLEAN
  /\ fromNull \in BOOLEAN

Init ==
  /\ status = "locked"
  /\ vault = "none"
  /\ planVault = "none"
  /\ compGen = 0
  /\ actGen = 0
  /\ opened = 0
  /\ timedOut = FALSE
  /\ fromNull = FALSE

UnlockPersonal ==
  /\ status = "locked"
  /\ status' = "unlocked"
  /\ vault' = "personal"
  /\ opened' = 0
  /\ timedOut' = FALSE
  /\ fromNull' = FALSE
  /\ UNCHANGED <<planVault, compGen, actGen>>

PlanForPersonal ==
  /\ status = "unlocked"
  /\ vault = "personal"
  /\ compGen < MaxGen
  /\ planVault' = "personal"
  /\ compGen' = compGen + 1
  /\ actGen' = actGen
  /\ fromNull' = (planVault = "none")
  /\ opened' = opened
  /\ UNCHANGED <<status, vault, timedOut>>

\* Effect after the render that closed the gate.
ClearStaleLatch ==
  /\ StaleOpenLatch
  /\ opened' = 0
  /\ fromNull' = FALSE
  /\ UNCHANGED <<status, vault, planVault, compGen, actGen, timedOut>>

ActivationCatchUp ==
  /\ status = "unlocked"
  /\ planVault = vault
  /\ actGen < compGen
  /\ actGen' = compGen
  /\ UNCHANGED <<status, vault, planVault, compGen, opened, timedOut, fromNull>>

ReadyOpens ==
  /\ ComputeReady
  /\ opened' = 2
  /\ UNCHANGED <<status, vault, planVault, compGen, actGen, timedOut, fromNull>>

WaitTimeout ==
  /\ status = "unlocked"
  /\ ~ComputeReady
  /\ ~timedOut
  /\ timedOut' = TRUE
  /\ opened' = 2
  /\ UNCHANGED <<status, vault, planVault, compGen, actGen, fromNull>>

\* Consent must not mount on composition alone before activation or timeout.
\* After the shell has opened once, later generations stay mounted (shell-ready.ts).
NoShellBeforeActivationOrTimeout ==
  ShellMounted =>
    ComputeReady \/ timedOut \/
    (OpenedMatchesVault /\ actGen < compGen /\ ~fromNull)

Spec ==
  Init /\ [][UnlockPersonal \/ PlanForPersonal \/ ClearStaleLatch
            \/ ActivationCatchUp \/ ReadyOpens \/ WaitTimeout]_vars

====