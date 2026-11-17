---------------------------- MODULE OpenVaultLease ----------------------------
EXTENDS Naturals
\* Finite model of vault-shared-locks open lease counters.

CONSTANTS MaxLive, MaxStale, MaxGen

VARIABLES count, gen, live, stale

vars == <<count, gen, live, stale>>

TypeOK ==
  /\ live \in 0..MaxLive
  /\ count = live
  /\ stale \in 0..MaxStale
  /\ gen \in 0..MaxGen

Init ==
  /\ count = 0
  /\ gen = 0
  /\ live = 0
  /\ stale = 0

Acquire ==
  /\ live < MaxLive
  /\ live' = live + 1
  /\ count' = live'
  /\ UNCHANGED <<gen, stale>>

ReleaseCurrent ==
  /\ live > 0
  /\ live' = live - 1
  /\ count' = live'
  /\ UNCHANGED <<gen, stale>>

ReleaseStale ==
  /\ stale > 0
  /\ stale' = stale - 1
  /\ UNCHANGED <<count, gen, live>>

ForgetLeases ==
  /\ stale + live <= MaxStale
  /\ gen < MaxGen
  /\ stale' = stale + live
  /\ live' = 0
  /\ count' = 0
  /\ gen' = gen + 1

TryExclusiveDestroy ==
  /\ count = 0
  /\ UNCHANGED vars

AfterForgetAcquire ==
  /\ count = 0
  /\ stale > 0
  /\ Acquire

CountMatchesLive == count = live

\* Exclusive destroy is only offered in the model when count is zero.
ExclusiveWhenOffered == TryExclusiveDestroy => count = 0

Spec ==
  Init /\ [][Acquire \/ ReleaseCurrent \/ ReleaseStale \/ ForgetLeases
            \/ TryExclusiveDestroy \/ AfterForgetAcquire]_vars

====