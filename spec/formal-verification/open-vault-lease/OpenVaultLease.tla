---------------------------- MODULE OpenVaultLease ----------------------------
EXTENDS Naturals
\* vault-shared-locks.ts: one tomb, finite tabs and generations.

CONSTANTS MaxLive, MaxStale, MaxGen

VARIABLES
  count,       \* openLeaseCounts for the tomb (drops when release() starts)
  gen,         \* leaseGeneration
  live,        \* current-generation acquires not yet finished releasing
  stale,       \* stale release() calls pending (noop on count when correct)
  releasing,   \* tabs mid release(): count drops before the Web Lock is done
  lockHeld,    \* shared locks still held after releaseCount
  exclusiveOk  \* exclusive destroy was offered and succeeded (count was 0)

vars == <<count, gen, live, stale, releasing, lockHeld, exclusiveOk>>

TypeOK ==
  /\ live \in 0..MaxLive
  /\ releasing \in 0..MaxLive
  /\ lockHeld \in 0..MaxLive
  /\ live + releasing <= MaxLive
  /\ count = live + releasing - lockHeld
  /\ stale \in 0..MaxStale
  /\ gen \in 0..MaxGen
  /\ exclusiveOk \in BOOLEAN

Init ==
  /\ count = 0
  /\ gen = 0
  /\ live = 0
  /\ stale = 0
  /\ releasing = 0
  /\ lockHeld = 0
  /\ exclusiveOk = FALSE

Acquire ==
  /\ live + releasing < MaxLive
  /\ live' = live + 1
  /\ count' = live' + releasing - lockHeld
  /\ exclusiveOk' = FALSE
  /\ UNCHANGED <<gen, stale, releasing, lockHeld>>

BeginReleaseCurrent ==
  /\ live > 0
  /\ live' = live - 1
  /\ releasing' = releasing + 1
  /\ lockHeld' = lockHeld + 1
  /\ count' = live' + releasing' - lockHeld'
  /\ UNCHANGED <<gen, stale, exclusiveOk>>

CompleteReleaseCurrent ==
  /\ releasing > 0
  /\ releasing' = releasing - 1
  /\ lockHeld' = lockHeld - 1
  /\ count' = live + releasing' - lockHeld'
  /\ UNCHANGED <<gen, live, stale, exclusiveOk>>

ReleaseStale ==
  /\ stale > 0
  /\ stale' = stale - 1
  /\ UNCHANGED <<count, gen, live, releasing, lockHeld, exclusiveOk>>

ForgetLeases ==
  /\ stale + live + releasing <= MaxStale
  /\ gen < MaxGen
  /\ stale' = stale + live + releasing
  /\ live' = 0
  /\ releasing' = lockHeld
  /\ count' = 0
  /\ gen' = gen + 1
  /\ exclusiveOk' = FALSE
  /\ UNCHANGED <<lockHeld>>

\* withExclusiveOpenLease: throws VaultStoreConflictError when count > 0.
TryExclusiveDestroy ==
  /\ count = 0
  /\ lockHeld = 0
  /\ exclusiveOk' = TRUE
  /\ UNCHANGED <<count, gen, live, stale, releasing, lockHeld>>

AfterForgetAcquire ==
  /\ count = 0
  /\ stale > 0
  /\ Acquire

CountMatchesLiveCount == count = live + releasing - lockHeld

\* Exclusive destroy is only offered when no tab counts the tomb open.
DestroyOnlyAtZero ==
  exclusiveOk => count = 0

NoDestroyWhileCountedOpen == count > 0 => ~exclusiveOk

\* releaseCount drops before held settles; exclusive must wait for the lock too.
NoExclusiveWhileLockHeld == exclusiveOk => lockHeld = 0

Spec ==
  Init /\ [][Acquire \/ BeginReleaseCurrent \/ CompleteReleaseCurrent
            \/ ReleaseStale \/ ForgetLeases \/ TryExclusiveDestroy
            \/ AfterForgetAcquire]_vars

====