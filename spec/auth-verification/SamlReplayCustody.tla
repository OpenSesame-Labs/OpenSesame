------------------------ MODULE SamlReplayCustody ------------------------
EXTENDS Naturals, FiniteSets

\* One volatile process, two issuers, two assertion identifiers, a capacity
\* of two and a bounded monotonic clock. Claim inputs have already passed
\* signature and protocol validation. Restart clears custody; the model does
\* not assert durability, distributed exclusion or SAML conformance.

Issuers == {"issuer-a", "issuer-b"}
Ids == {"id-x", "id-y"}
Keys == Issuers \X Ids
None == 4
Capacity == 2
Other(key) == <<IF key[1] = "issuer-a" THEN "issuer-b" ELSE "issuer-a", key[2]>>
Active(entries, time) == {key \in Keys: entries[key] # None /\ entries[key] > time}

VARIABLES entries, now, seen, repeated, action, result, lastKey, lastExpiry,
          hadActive, hadOther, wasFull
vars == <<entries, now, seen, repeated, action, result, lastKey, lastExpiry,
          hadActive, hadOther, wasFull>>

Init == /\ entries = [key \in Keys |-> None] /\ now = 0 /\ seen = {}
        /\ repeated = FALSE /\ action = "init" /\ result = "none"
        /\ lastKey = <<"issuer-a", "id-x">> /\ lastExpiry = 0
        /\ hadActive = FALSE /\ hadOther = FALSE /\ wasFull = FALSE

Advance ==
  /\ now < 3 /\ now' = now + 1 /\ action' = "advance"
  /\ UNCHANGED <<entries, seen, repeated, result, lastKey, lastExpiry,
                 hadActive, hadOther, wasFull>>

Claim(key, expiry) ==
  /\ key \in Keys /\ expiry \in 0..3
  /\ LET active == Active(entries, now)
         pruned == [k \in Keys |-> IF k \in active THEN entries[k] ELSE None]
         accepted == expiry > now /\ key \notin active /\ Cardinality(active) < Capacity
     IN /\ hadActive' = (key \in active)
        /\ hadOther' = (Other(key) \in active)
        /\ wasFull' = (Cardinality(active) >= Capacity)
        /\ entries' = IF accepted THEN [pruned EXCEPT ![key] = expiry] ELSE pruned
        /\ seen' = IF accepted THEN seen \cup {key} ELSE seen
        /\ repeated' = (repeated \/ (accepted /\ key \in seen))
        /\ result' = IF accepted THEN "accepted" ELSE "denied"
  /\ lastKey' = key /\ lastExpiry' = expiry /\ action' = "claim"
  /\ UNCHANGED now

Restart ==
  /\ entries' = [key \in Keys |-> None] /\ action' = "restart"
  /\ UNCHANGED <<now, seen, repeated, result, lastKey, lastExpiry,
                 hadActive, hadOther, wasFull>>

Next == Advance \/ Restart \/ (\E key \in Keys, expiry \in 0..3: Claim(key, expiry))
Spec == Init /\ [][Next]_vars

TypeOK == /\ entries \in [Keys -> (0..3) \cup {None}]
          /\ now \in 0..3 /\ seen \subseteq Keys /\ repeated \in BOOLEAN
          /\ action \in {"init", "advance", "claim", "restart"}
          /\ result \in {"none", "accepted", "denied"}
          /\ lastKey \in Keys /\ lastExpiry \in 0..3
          /\ hadActive \in BOOLEAN /\ hadOther \in BOOLEAN /\ wasFull \in BOOLEAN
CapacityRespected == Cardinality({key \in Keys: entries[key] # None}) <= Capacity
RetainedReplayDenied == action = "claim" /\ hadActive => result = "denied"
ExpiredAssertionDenied == action = "claim" /\ lastExpiry <= now => result = "denied"
FullCustodyDenies == action = "claim" /\ wasFull => result = "denied"
OtherIssuerPreserved == action = "claim" /\ hadOther => entries[Other(lastKey)] # None /\ entries[Other(lastKey)] > now
AcceptedWasFresh == action = "claim" /\ result = "accepted" => lastExpiry > now /\ ~hadActive /\ ~wasFull

\* Deliberately false reachability and durability claims for negative controls.
AcceptanceUnreachable == seen = {}
NoReplayAcrossRestartOrExpiry == ~repeated
=============================================================================
