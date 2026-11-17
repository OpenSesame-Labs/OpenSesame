-------------------------- MODULE VaultInteraction --------------------------
\* An abstraction of an unlock attempt waiting for its session lease. Lock,
\* cancellation, and scope changes retire the attempt. A late lease must have
\* release requested instead of publishing its key or disturbing the newer
\* session. Whether the external release succeeds is outside the model.
\* This is a finite model of that boundary, not a model of vault cryptography.

Attempts == {"a", "b", "c"}
Scopes == {"personal", "other"}
None == "none"

VARIABLES created, current, retired, scope, scopeOf, started, resolved,
          releaseRequested, keyOwner, late, beforeCurrent, beforeKey

vars == <<created, current, retired, scope, scopeOf, started, resolved,
          releaseRequested, keyOwner, late, beforeCurrent, beforeKey>>

Init == /\ created = {}
        /\ current = None
        /\ retired = {}
        /\ scope = "personal"
        /\ scopeOf = [a \in Attempts |-> None]
        /\ started = {}
        /\ resolved = {}
        /\ releaseRequested = {}
        /\ keyOwner = None
        /\ late = FALSE
        /\ beforeCurrent = None
        /\ beforeKey = None

ForgetObservation == /\ late' = FALSE
                     /\ beforeCurrent' = None
                     /\ beforeKey' = None

RetireCurrent ==
  /\ retired' = IF current = None THEN retired ELSE retired \cup {current}
  /\ releaseRequested' = IF current \in resolved
                            THEN releaseRequested \cup {current}
                            ELSE releaseRequested

Begin(a) ==
  /\ a \in Attempts \ created
  /\ RetireCurrent
  /\ created' = created \cup {a}
  /\ current' = a
  /\ scopeOf' = [scopeOf EXCEPT ![a] = scope]
  /\ keyOwner' = None
  /\ ForgetObservation
  /\ UNCHANGED <<scope, started, resolved>>

Start ==
  /\ current # None
  /\ current \notin started
  /\ started' = started \cup {current}
  /\ ForgetObservation
  /\ UNCHANGED <<created, current, retired, scope, scopeOf, resolved,
                 releaseRequested, keyOwner>>

Retire ==
  /\ current # None
  /\ RetireCurrent
  /\ current' = None
  /\ keyOwner' = None
  /\ ForgetObservation
  /\ UNCHANGED <<created, scope, scopeOf, started, resolved>>

SwitchScope ==
  /\ RetireCurrent
  /\ current' = None
  /\ scope' = IF scope = "personal" THEN "other" ELSE "personal"
  /\ keyOwner' = None
  /\ ForgetObservation
  /\ UNCHANGED <<created, scopeOf, started, resolved>>

Resolve(a) ==
  /\ a \in started \ resolved
  /\ resolved' = resolved \cup {a}
  /\ IF a = current /\ scopeOf[a] = scope
        THEN /\ keyOwner' = a
             /\ UNCHANGED releaseRequested
             /\ ForgetObservation
        ELSE /\ releaseRequested' = releaseRequested \cup {a}
             /\ late' = TRUE
             /\ beforeCurrent' = current
             /\ beforeKey' = keyOwner
             /\ UNCHANGED keyOwner
  /\ UNCHANGED <<created, current, retired, scope, scopeOf, started>>

Next == (\E a \in Attempts: Begin(a) \/ Resolve(a))
        \/ Start \/ Retire \/ SwitchScope
Spec == Init /\ [][Next]_vars

TypeOK == /\ created \subseteq Attempts
          /\ current \in Attempts \cup {None}
          /\ retired \subseteq created
          /\ scope \in Scopes
          /\ scopeOf \in [Attempts -> Scopes \cup {None}]
          /\ started \subseteq created
          /\ resolved \subseteq started
          /\ releaseRequested \subseteq resolved
          /\ keyOwner \in Attempts \cup {None}
          /\ late \in BOOLEAN
          /\ beforeCurrent \in Attempts \cup {None}
          /\ beforeKey \in Attempts \cup {None}

OnlyCurrentCanPublish ==
  keyOwner # None =>
    /\ keyOwner = current
    /\ keyOwner \notin retired
    /\ scopeOf[keyOwner] = scope

RetiredResolvedLeasesRequestRelease ==
  retired \cap resolved \subseteq releaseRequested

LateCompletionPreservesNewSession ==
  late => /\ current = beforeCurrent
          /\ keyOwner = beforeKey

CurrentNeverRetired == current = None \/ current \notin retired
=============================================================================
