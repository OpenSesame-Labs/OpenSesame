---------------------------- MODULE ReleasePromotion ----------------------------
EXTENDS Naturals
\* Promotion must authorize the same qualified candidate bytes, not a rewrite.

VARIABLES publishedId, promotedId, payloadMatch, authorized

vars == <<publishedId, promotedId, payloadMatch, authorized>>

Init ==
  /\ publishedId = 0
  /\ promotedId = 0
  /\ payloadMatch = TRUE
  /\ authorized = FALSE

PublishCandidate ==
  /\ publishedId' = publishedId + 1
  /\ UNCHANGED <<promotedId, payloadMatch, authorized>>

Promote ==
  /\ promotedId' = publishedId
  /\ IF payloadMatch
     THEN authorized' = TRUE
     ELSE authorized' = FALSE
  /\ UNCHANGED publishedId

RewriteVersion ==
  /\ promotedId' # publishedId
  /\ authorized' = FALSE
  /\ UNCHANGED <<publishedId, payloadMatch>>

NoPromotionRewrite == ~authorized \/ (promotedId = publishedId /\ payloadMatch)

Spec == Init /\ [][PublishCandidate \/ Promote \/ RewriteVersion]_vars

====