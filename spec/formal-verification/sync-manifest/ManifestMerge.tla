---------------------------- MODULE ManifestMerge ----------------------------
EXTENDS Naturals
\* store-sync planManifestMerge: tombstoned items are omitted from byPath.

VARIABLES tombstoned, manifestHasPath, mergeAdds, mergeUpdates

vars == <<tombstoned, manifestHasPath, mergeAdds, mergeUpdates>>

Init ==
  /\ tombstoned = FALSE
  /\ manifestHasPath = FALSE
  /\ mergeAdds = FALSE
  /\ mergeUpdates = FALSE

TombstoneItem ==
  /\ tombstoned' = TRUE
  /\ mergeAdds' = FALSE
  /\ mergeUpdates' = FALSE
  /\ UNCHANGED manifestHasPath

\* A trashed path comes back as a new item. It is not patched in place.
ImportManifest ==
  /\ manifestHasPath' = TRUE
  /\ IF tombstoned
     THEN /\ mergeAdds' = TRUE
          /\ mergeUpdates' = FALSE
     ELSE /\ mergeAdds' = FALSE
          /\ mergeUpdates' = TRUE
  /\ UNCHANGED tombstoned

NoReviveTombstone == tombstoned => ~mergeUpdates

Spec == Init /\ [][TombstoneItem \/ ImportManifest]_vars

====