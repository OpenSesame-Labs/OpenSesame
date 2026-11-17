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
  timedOut         \* bounded wait fired

vars == <<status, vault, planVault, compGen, actGen, opened, timedOut>>

OpenedMatchesVault == opened = 2
OpenedUnset == opened = 0

ComputeReady ==
  /\ status = "unlocked"
  /\ \/ planVault = "none"
     \/ /\ planVault = vault
        /\ actGen = compGen

ShellMounted ==
  \/ ComputeReady
  \/ /\ status = "unlocked"
     /\ OpenedMatchesVault

TypeOK ==
  /\ status \in {"locked", "unlocked"}
  /\ vault \in {"personal", "guest", "none"}
  /\ planVault \in {"none", "personal", "guest", "other"}
  /\ compGen \in 0..MaxGen
  /\ actGen \in 0..MaxGen
  /\ opened \in {0, 1, 2}
  /\ timedOut \in BOOLEAN

Init ==
  /\ status = "locked"
  /\ vault = "none"
  /\ planVault = "none"
  /\ compGen = 0
  /\ actGen = 0
  /\ opened = 0
  /\ timedOut = FALSE

UnlockPersonal ==
  /\ status = "locked"
  /\ status' = "unlocked"
  /\ vault' = "personal"
  /\ opened' = 0
  /\ timedOut' = FALSE
  /\ UNCHANGED <<planVault, compGen, actGen>>

PlanForPersonal ==
  /\ status = "unlocked"
  /\ vault = "personal"
  /\ planVault' = "personal"
  /\ compGen' = compGen + 1
  /\ actGen' = actGen
  /\ opened' = IF timedOut THEN opened ELSE 0
  /\ UNCHANGED <<status, vault, timedOut>>

ActivationCatchUp ==
  /\ status = "unlocked"
  /\ planVault = vault
  /\ actGen < compGen
  /\ actGen' = compGen
  /\ UNCHANGED <<status, vault, planVault, compGen, opened, timedOut>>

ReadyOpens ==
  /\ ComputeReady
  /\ opened' = 2
  /\ UNCHANGED <<status, vault, planVault, compGen, actGen, timedOut>>

WaitTimeout ==
  /\ status = "unlocked"
  /\ ~ComputeReady
  /\ ~timedOut
  /\ timedOut' = TRUE
  /\ opened' = 2
  /\ UNCHANGED <<status, vault, planVault, compGen, actGen>>

\* Consent must not mount on composition alone before activation or timeout.
NoShellBeforeActivationOrTimeout ==
  ShellMounted => ComputeReady \/ timedOut

Spec ==
  Init /\ [][UnlockPersonal \/ PlanForPersonal \/ ActivationCatchUp
            \/ ReadyOpens \/ WaitTimeout]_vars

====