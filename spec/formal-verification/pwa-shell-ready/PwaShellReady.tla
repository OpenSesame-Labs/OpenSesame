---------------------------- MODULE PwaShellReady ----------------------------
EXTENDS Naturals
\* apps/pages/src/bindings/shell-ready.ts computeShellReady

CONSTANT MaxGen

VARIABLES
  status,          \* "locked" | "unlocked"
  vault,           \* tomb string when unlocked
  planVault,       \* "none" or vault id
  compGen,
  actGen,
  opened,          \* 0 = undefined, 1 = null, 2 = matches vault
  timedOut,
  awaitingPlanActivation

vars == <<status, vault, planVault, compGen, actGen, opened, timedOut, awaitingPlanActivation>>

OpenedMatchesVault == opened = 2

\* Mirrors computeShellReady "ready" branch.
ComputeReady ==
  /\ status = "unlocked"
  /\ planVault = vault
  /\ actGen = compGen

\* Mirrors computeShellReady "waitedOpen" branch (openedVault === vault).
WaitedOpen ==
  /\ status = "unlocked"
  /\ OpenedMatchesVault
  /\ \/ planVault = "none"
     \/ timedOut
     \/ /\ planVault = vault
        /\ ~awaitingPlanActivation

ShellMounted == ComputeReady \/ WaitedOpen

TypeOK ==
  /\ status \in {"locked", "unlocked"}
  /\ vault \in {"personal", "guest", "none"}
  /\ planVault \in {"none", "personal", "guest", "other"}
  /\ compGen \in 0..MaxGen
  /\ actGen \in 0..MaxGen
  /\ opened \in {0, 1, 2}
  /\ timedOut \in BOOLEAN
  /\ awaitingPlanActivation \in BOOLEAN

Init ==
  /\ status = "locked"
  /\ vault = "none"
  /\ planVault = "none"
  /\ compGen = 0
  /\ actGen = 0
  /\ opened = 0
  /\ timedOut = FALSE
  /\ awaitingPlanActivation = FALSE

UnlockPersonal ==
  /\ status = "locked"
  /\ status' = "unlocked"
  /\ vault' = "personal"
  /\ opened' = 0
  /\ timedOut' = FALSE
  /\ awaitingPlanActivation' = FALSE
  /\ UNCHANGED <<planVault, compGen, actGen>>

PlanForPersonal ==
  /\ status = "unlocked"
  /\ vault = "personal"
  /\ compGen < MaxGen
  /\ planVault' = "personal"
  /\ compGen' = compGen + 1
  /\ actGen' = actGen
  /\ awaitingPlanActivation' =
       IF planVault = "none" THEN TRUE ELSE awaitingPlanActivation
  /\ opened' = opened
  /\ UNCHANGED <<status, vault, timedOut>>

\* Render after null-to-plan before activation catches up (useShellReady effect).
ClearAwaitingLatch ==
  /\ status = "unlocked"
  /\ awaitingPlanActivation
  /\ planVault = vault
  /\ actGen < compGen
  /\ ~timedOut
  /\ opened' = 0
  /\ awaitingPlanActivation' = FALSE
  /\ UNCHANGED <<status, vault, planVault, compGen, actGen, timedOut>>

ActivationCatchUp ==
  /\ status = "unlocked"
  /\ planVault = vault
  /\ actGen < compGen
  /\ actGen' = compGen
  /\ awaitingPlanActivation' = FALSE
  /\ UNCHANGED <<status, vault, planVault, compGen, opened, timedOut>>

ReadyOpens ==
  /\ ComputeReady
  /\ opened' = 2
  /\ awaitingPlanActivation' = FALSE
  /\ UNCHANGED <<status, vault, planVault, compGen, actGen, timedOut>>

WaitTimeout ==
  /\ status = "unlocked"
  /\ ~ComputeReady
  /\ ~timedOut
  /\ timedOut' = TRUE
  /\ opened' = 2
  /\ UNCHANGED <<status, vault, planVault, compGen, actGen, awaitingPlanActivation>>

NoAwaitingBeforeMount ==
  awaitingPlanActivation /\ ~timedOut => ~ShellMounted

\* After the shell has opened once, later generations stay mounted across activation.
OpenShellStaysMounted ==
  /\ status = "unlocked"
  /\ OpenedMatchesVault
  /\ planVault = vault
  /\ ~awaitingPlanActivation
  /\ actGen < compGen
  => ShellMounted

Spec ==
  Init /\ [][UnlockPersonal \/ PlanForPersonal \/ ClearAwaitingLatch
            \/ ActivationCatchUp \/ ReadyOpens \/ WaitTimeout]_vars

====