------------------ MODULE FederatedPendingIntegrity ------------------
EXTENDS Naturals

\* One cookie and one attacker-controlled payload. MACs are ideal: modern
\* signatures authenticate the complete encoded payload, legacy signatures
\* authenticate only core, and the two keys cannot forge each other's tags.
\* Core abstracts all legacy-bound fields as an injective value. This does
\* not model cryptography, cookie delivery, replay, expiry or issuer trust.

Cores == {"core-a", "core-b"}
Ids == {"none", "a", "b"}
Formats == {"modern", "legacy"}
Phases == {"issued", "accepted", "rejected"}

VARIABLES format, signedCore, signedOrg, signedByo, core, org, byo, phase, action
vars == <<format, signedCore, signedOrg, signedByo, core, org, byo, phase, action>>

Init == /\ format \in Formats /\ signedCore \in Cores /\ signedOrg \in Ids /\ signedByo \in Ids
        /\ core = signedCore /\ org = signedOrg /\ byo = signedByo
        /\ phase = "issued" /\ action = "issue"

Alter(newCore, newOrg, newByo) ==
  /\ phase = "issued"
  /\ newCore \in Cores /\ newOrg \in Ids /\ newByo \in Ids
  /\ core' = newCore /\ org' = newOrg /\ byo' = newByo /\ action' = "alter"
  /\ UNCHANGED <<format, signedCore, signedOrg, signedByo, phase>>

Verify ==
  /\ phase = "issued"
  /\ LET modernValid == format = "modern" /\ core = signedCore /\
                       org = signedOrg /\ byo = signedByo
         legacyValid == format = "legacy" /\ core = signedCore /\
                       org = "none" /\ byo = "none"
     IN phase' = IF modernValid \/ legacyValid THEN "accepted" ELSE "rejected"
  /\ action' = "verify"
  /\ UNCHANGED <<format, signedCore, signedOrg, signedByo, core, org, byo>>

Next == (\E c \in Cores, o \in Ids, b \in Ids: Alter(c, o, b)) \/ Verify
Spec == Init /\ [][Next]_vars

TypeOK == /\ format \in Formats /\ signedCore \in Cores /\ signedOrg \in Ids /\ signedByo \in Ids
          /\ core \in Cores /\ org \in Ids /\ byo \in Ids /\ phase \in Phases
          /\ action \in {"issue", "alter", "verify"}
ModernAcceptBindsPayload == phase = "accepted" /\ format = "modern" =>
  core = signedCore /\ org = signedOrg /\ byo = signedByo
LegacyCannotGrantUnboundContext == phase = "accepted" /\ format = "legacy" =>
  org = "none" /\ byo = "none"
AcceptedCoreMatches == phase = "accepted" => core = signedCore

LegacyContextRejectionUnreachable ==
  ~(format = "legacy" /\ signedOrg # "none" /\ org = signedOrg /\ phase = "rejected")
ModernAcceptanceUnreachable == ~(format = "modern" /\ phase = "accepted")
=============================================================================
