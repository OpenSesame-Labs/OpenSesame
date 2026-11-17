--------------------- MODULE FederatedTrustBinding ---------------------
EXTENDS Naturals

\* One callback after trust is re-resolved. The pending cookie is assumed
\* authentic; FederatedPendingIntegrity models that separately. Static legacy
\* cookies are supported, while organization and visitor records must retain
\* the exact source and stable record ID that began the flow.

Sources == {"legacy", "static", "org", "byo"}
CurrentSources == {"static", "org", "byo"}
Ids == {"a", "b"}
Kinds == {"oidc", "oauth2"}

VARIABLES startedSource, startedId, currentSource, currentId, pendingKind, currentKind,
          provenanceCount, phase, acceptedSource, acceptedId, action
vars == <<startedSource, startedId, currentSource, currentId, pendingKind, currentKind,
          provenanceCount, phase, acceptedSource, acceptedId, action>>

Init == /\ startedSource \in Sources /\ startedId \in Ids
        /\ currentSource \in CurrentSources /\ currentId \in Ids
        /\ pendingKind \in Kinds /\ currentKind \in Kinds
        /\ provenanceCount \in 0..3
        /\ phase = "pending" /\ acceptedSource = "none" /\ acceptedId = "none"
        /\ action = "start"

Complete ==
  /\ phase = "pending"
  /\ LET exact == startedSource = currentSource /\ startedId = currentId
         legacy == startedSource = "legacy" /\ currentSource = "static"
         admitted == pendingKind = "oidc" /\ currentKind = "oidc"
                       /\ provenanceCount <= 1 /\ (exact \/ legacy)
     IN /\ phase' = IF admitted THEN "accepted" ELSE "rejected"
        /\ acceptedSource' = IF admitted THEN currentSource ELSE "none"
        /\ acceptedId' = IF admitted THEN currentId ELSE "none"
  /\ action' = "complete"
  /\ UNCHANGED <<startedSource, startedId, currentSource, currentId, pendingKind, currentKind,
                 provenanceCount>>

Next == Complete
Spec == Init /\ [][Next]_vars

TypeOK == /\ startedSource \in Sources /\ startedId \in Ids
          /\ currentSource \in CurrentSources /\ currentId \in Ids
          /\ pendingKind \in Kinds /\ currentKind \in Kinds
          /\ provenanceCount \in 0..3
          /\ phase \in {"pending", "accepted", "rejected"}
          /\ acceptedSource \in {"none", "static", "org", "byo"}
          /\ acceptedId \in {"none", "a", "b"}
          /\ action \in {"start", "complete"}
AcceptedPendingIsOidc == phase = "accepted" => pendingKind = "oidc"
AcceptedAuthorityIsOidc == phase = "accepted" => currentKind = "oidc"
AcceptedHasSingleProvenance == phase = "accepted" => provenanceCount <= 1
AcceptedSourceBound == phase = "accepted" =>
  (startedSource = "legacy" /\ acceptedSource = "static") \/
  startedSource = acceptedSource
AcceptedIdBound == phase = "accepted" /\ startedSource # "legacy" =>
  startedId = acceptedId
LegacyCannotGainDynamicTrust == phase = "accepted" /\ startedSource = "legacy" =>
  acceptedSource = "static"

MatchingAcceptanceUnreachable ==
  ~(phase = "accepted" /\ startedSource = "org" /\ currentSource = "org" /\ startedId = currentId)
ReboundRejectionUnreachable ==
  ~(phase = "rejected" /\ startedSource = "org" /\ currentSource = "byo")
=============================================================================
