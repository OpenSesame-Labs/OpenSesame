---------------------------- MODULE VaultPresentation ----------------------------
\* Published vault screen for one session.
\*
\* buildVaultState (packages/app-core/src/lib/vault/store-presentation.ts)
\*   status = open ? "unlocked" : header ? "locked" : "empty"
\*   awaitingSecondStep = pending && !open
\* open is #vaultKey !== null. pending is #pendingVaultKey !== null.
\*
\* StoreUnlockSession.activate (store-unlock-session.ts) sets the key and
\* then clears the parked key before the store publishes. requireTrusted
\* clears the parked key before it publishes a circle wait. lock
\* (store.ts) clears both. #afterPrimaryUnwrap parks the key and publishes
\* only when a second step is enrolled; otherwise it opens.
\*
\* BuggyUnlock is FALSE in the committed config. That is the code.
\* The scratch proof sets it TRUE: opening then leaves the parked key in
\* place and reports the second step from pending alone, dropping !open.

CONSTANT BuggyUnlock

VARIABLES
  header,    \* a vault record is on this session
  open,      \* #vaultKey !== null
  pending,   \* #pendingVaultKey !== null
  enrolled,  \* hasSecondStep(header)
  ephemeral, \* guest session; lock wipes the header
  circle,    \* a trusted-contact policy is enrolled
  trusted,   \* circle approval is on screen, vault not open yet
  status,
  awaitingSecondStep

vars == <<header, open, pending, enrolled, ephemeral, circle, trusted,
          status, awaitingSecondStep>>

\* The formula buildVaultState publishes. o, h, p are the next flags.
Present(o, h, p) ==
  /\ status' = IF o THEN "unlocked" ELSE IF h THEN "locked" ELSE "empty"
  /\ awaitingSecondStep' = (p /\ ~o)

Init ==
  /\ header = FALSE
  /\ open = FALSE
  /\ pending = FALSE
  /\ enrolled = FALSE
  /\ ephemeral = FALSE
  /\ circle = FALSE
  /\ trusted = FALSE
  /\ status = "empty"
  /\ awaitingSecondStep = FALSE

\* #persistNewVault / create: empty device, key installed, nothing parked.
CreateVault ==
  /\ ~header /\ ~open /\ ~pending /\ ~trusted
  /\ header' = TRUE
  /\ open' = TRUE
  /\ pending' = FALSE
  /\ enrolled' = FALSE
  /\ ephemeral' = FALSE
  /\ trusted' = FALSE
  /\ circle' \in BOOLEAN
  /\ Present(open', header', pending')

\* createGuest from an empty device. A guest beside an existing vault
\* (hand-back on lock) is outside this model.
CreateGuest ==
  /\ ~header /\ ~open /\ ~pending /\ ~trusted
  /\ header' = TRUE
  /\ open' = TRUE
  /\ pending' = FALSE
  /\ enrolled' = FALSE
  /\ ephemeral' = TRUE
  /\ circle' = FALSE
  /\ trusted' = FALSE
  /\ Present(open', header', pending')

\* Second-step enrollment is refused for a guest and requires an open vault.
EnrollSecondStep ==
  /\ open /\ header /\ ~pending /\ ~ephemeral /\ ~enrolled /\ ~trusted
  /\ enrolled' = TRUE
  /\ header' = header
  /\ open' = open
  /\ pending' = pending
  /\ ephemeral' = ephemeral
  /\ circle' = circle
  /\ trusted' = trusted
  /\ Present(open', header', pending')

RemoveSecondStep ==
  /\ open /\ enrolled /\ ~ephemeral /\ ~pending
  /\ enrolled' = FALSE
  /\ header' = header
  /\ open' = open
  /\ pending' = pending
  /\ ephemeral' = ephemeral
  /\ circle' = circle
  /\ trusted' = trusted
  /\ Present(open', header', pending')

\* lock(), including idle lock, cancel, and second-step expiry: each one
\* calls lock, which drops the key and the parked key before publish.
\* A guest lock also drops the header.
Lock ==
  /\ open \/ pending \/ trusted
  /\ open' = FALSE
  /\ pending' = FALSE
  /\ trusted' = FALSE
  /\ IF ephemeral
       THEN /\ header' = FALSE
            /\ enrolled' = FALSE
            /\ ephemeral' = FALSE
            /\ circle' = FALSE
       ELSE /\ header' = header
            /\ enrolled' = enrolled
            /\ ephemeral' = ephemeral
            /\ circle' = circle
  /\ Present(open', header', pending')

\* #afterPrimaryUnwrap. A second step parks the key and publishes.
\* Otherwise requireTrusted either opens (no circle) or publishes the circle.
PrimaryUnlock ==
  /\ header /\ ~open /\ ~pending /\ ~trusted
  /\ header' = header
  /\ enrolled' = enrolled
  /\ ephemeral' = ephemeral
  /\ circle' = circle
  /\ IF enrolled
       THEN /\ pending' = TRUE
            /\ open' = FALSE
            /\ trusted' = FALSE
       ELSE IF circle
         THEN /\ pending' = FALSE
              /\ open' = FALSE
              /\ trusted' = TRUE
         ELSE /\ pending' = FALSE
              /\ open' = TRUE
              /\ trusted' = FALSE
  /\ Present(open', header', pending')

\* confirmTotp / confirm code / recovery -> finishSecondStepUnlock ->
\* requireTrusted. The parked key is cleared before publish. A circle
\* waits locked; otherwise activate opens.
FinishSecondStep ==
  /\ ~BuggyUnlock
  /\ pending /\ ~open /\ header
  /\ header' = header
  /\ enrolled' = enrolled
  /\ ephemeral' = ephemeral
  /\ circle' = circle
  /\ pending' = FALSE
  /\ IF circle
       THEN /\ open' = FALSE
            /\ trusted' = TRUE
       ELSE /\ open' = TRUE
            /\ trusted' = FALSE
  /\ Present(open', header', pending')

\* Scratch variant only. Opens while the parked key is still set, and
\* reports awaitingSecondStep from pending, without /\ ~open.
BuggyUnlockOpen ==
  /\ BuggyUnlock
  /\ pending /\ ~open /\ header
  /\ header' = header
  /\ enrolled' = enrolled
  /\ ephemeral' = ephemeral
  /\ circle' = circle
  /\ open' = TRUE
  /\ pending' = TRUE
  /\ trusted' = FALSE
  /\ status' = "unlocked"
  /\ awaitingSecondStep' = pending'

\* confirmTrusted -> activate. The key is set and nothing is parked.
ConfirmTrusted ==
  /\ trusted /\ ~open /\ ~pending
  /\ header' = header
  /\ enrolled' = enrolled
  /\ ephemeral' = ephemeral
  /\ circle' = circle
  /\ open' = TRUE
  /\ pending' = FALSE
  /\ trusted' = FALSE
  /\ Present(open', header', pending')

Next ==
  \/ CreateVault
  \/ CreateGuest
  \/ EnrollSecondStep
  \/ RemoveSecondStep
  \/ Lock
  \/ PrimaryUnlock
  \/ FinishSecondStep
  \/ BuggyUnlockOpen
  \/ ConfirmTrusted

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ header \in BOOLEAN
  /\ open \in BOOLEAN
  /\ pending \in BOOLEAN
  /\ enrolled \in BOOLEAN
  /\ ephemeral \in BOOLEAN
  /\ circle \in BOOLEAN
  /\ trusted \in BOOLEAN
  /\ status \in {"empty", "locked", "unlocked"}
  /\ awaitingSecondStep \in BOOLEAN

\* True of every published snapshot buildVaultState builds.
PresentationMatchesStore ==
  /\ status = IF open THEN "unlocked" ELSE IF header THEN "locked" ELSE "empty"
  /\ awaitingSecondStep = (pending /\ ~open)

\* The screen never says the second step is still waiting once the vault is open.
NoStalePendingWhileOpen == ~(awaitingSecondStep /\ open)

\* activate / create / lock publish an open session only after the parked key is gone.
OpenSessionHasNoParkedKey == open => ~pending

=============================================================================
