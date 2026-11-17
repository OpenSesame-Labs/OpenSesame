---------------------------- MODULE OnboardingRecovery ----------------------------
EXTENDS Naturals
\* Half-finished enroll must not publish unlocked while the second step waits.

VARIABLES pending, open, publishedUnlocked

vars == <<pending, open, publishedUnlocked>>

Init ==
  /\ pending = FALSE
  /\ open = FALSE
  /\ publishedUnlocked = FALSE

ParkSecondStep ==
  /\ pending' = TRUE
  /\ open' = FALSE
  /\ publishedUnlocked' = FALSE

FinishUnlock ==
  /\ pending' = FALSE
  /\ open' = TRUE
  /\ publishedUnlocked' = TRUE

BuggyPublish ==
  /\ pending
  /\ publishedUnlocked' = TRUE
  /\ UNCHANGED <<pending, open>>

NoUnlockedWhilePending == ~(pending /\ publishedUnlocked)

Spec == Init /\ [][ParkSecondStep \/ FinishUnlock]_vars

====