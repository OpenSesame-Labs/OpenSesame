---------------------------- MODULE ReleasePromotion ----------------------------
EXTENDS Naturals
\* Promotion must authorize the same qualified candidate bytes, not a rewrite.

CONSTANT MaxPublish

VARIABLES publishedId, promotedId, payloadMatch, authorized

vars == <<publishedId, promotedId, payloadMatch, authorized>>

Init ==
  /\ publishedId = 0
  /\ promotedId = 0
  /\ payloadMatch = TRUE
  /\ authorized = FALSE

PublishCandidate ==
  /\ publishedId < MaxPublish
  /\ publishedId' = publishedId + 1
  /\ authorized' = FALSE
  /\ UNCHANGED <<promotedId, payloadMatch>>

Promote ==
  /\ promotedId' = publishedId
  /\ IF payloadMatch
     THEN authorized' = TRUE
     ELSE authorized' = FALSE
  /\ UNCHANGED <<publishedId, payloadMatch>>

RewriteVersion ==
  /\ promotedId' = publishedId + 1
  /\ authorized' = FALSE
  /\ UNCHANGED <<publishedId, payloadMatch>>

TamperPayload ==
  /\ payloadMatch' = FALSE
  /\ authorized' = FALSE
  /\ UNCHANGED <<publishedId, promotedId>>

NoPromotionRewrite == ~authorized \/ (promotedId = publishedId /\ payloadMatch)

Spec == Init /\ [][PublishCandidate \/ Promote \/ RewriteVersion \/ TamperPayload]_vars

====