---------------------------- MODULE OnboardingRecovery ----------------------------
EXTENDS Naturals
\* Half-finished enroll must not publish unlocked while the second step waits.

CONSTANT BuggyPublish
\* BuggyPublish is FALSE in the committed config. That is the code.

VARIABLES pending, open, publishedUnlocked

vars == <<pending, open, publishedUnlocked>>

Init ==
  /\ pending = FALSE
  /\ open = FALSE
  /\ publishedUnlocked = FALSE

ParkSecondStep ==
  /\ ~pending
  /\ pending' = TRUE
  /\ open' = FALSE
  /\ publishedUnlocked' = FALSE

FinishUnlock ==
  /\ pending
  /\ pending' = FALSE
  /\ open' = TRUE
  /\ publishedUnlocked' = TRUE

BuggyPublishWhilePending ==
  /\ BuggyPublish
  /\ pending
  /\ publishedUnlocked' = TRUE
  /\ UNCHANGED <<pending, open>>

NoUnlockedWhilePending == ~(pending /\ publishedUnlocked)

Spec == Init /\ [][ParkSecondStep \/ FinishUnlock \/ BuggyPublishWhilePending]_vars

====