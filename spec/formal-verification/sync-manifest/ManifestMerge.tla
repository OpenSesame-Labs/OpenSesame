---------------------------- MODULE ManifestMerge ----------------------------
EXTENDS Naturals
\* store-sync planManifestMerge: tombstoned items are omitted from byPath.

VARIABLES tombstoned, manifestHasPath, mergeAdds

vars == <<tombstoned, manifestHasPath, mergeAdds>>

Init ==
  /\ tombstoned = FALSE
  /\ manifestHasPath = FALSE
  /\ mergeAdds = FALSE

TombstoneItem ==
  /\ tombstoned' = TRUE
  /\ UNCHANGED <<manifestHasPath, mergeAdds>>

ImportManifest ==
  /\ manifestHasPath' = TRUE
  /\ IF tombstoned
     THEN mergeAdds' = FALSE
     ELSE mergeAdds' = TRUE
  /\ UNCHANGED tombstoned

NoReviveTombstone == tombstoned => ~mergeAdds

Spec == Init /\ [][TombstoneItem \/ ImportManifest]_vars

====