# Vault unlock screen

The vault screen never says a second step is still waiting while the vault is open.

`buildVaultState` in `packages/app-core/src/lib/vault/store-presentation.ts` is the snapshot every surface reads. It sets `status` to `unlocked` when the session holds the vault key, `locked` when a vault record exists and the key does not, and `empty` when there is no record. It sets `awaitingSecondStep` to the parked second-step key and not the open key: `pending && !open`.

That split is what keeps an open session from looking like a challenge. Callers treat `awaitingSecondStep` as "the key is parked and the vault is not open" (the CLI refuses the snapshot, identity setup stays hidden, a cancel of the challenge locks). If the flag stayed true after the vault opened, those callers would treat an open vault as unfinished, and cancelling the challenge would lock a session the person had already opened.

The model checks three invariants on every published snapshot:

- `PresentationMatchesStore` — `status` and `awaitingSecondStep` match `buildVaultState`.
- `NoStalePendingWhileOpen` — the screen does not say the second step is waiting while the vault is open.
- `OpenSessionHasNoParkedKey` — an open session has already dropped the parked key, which is what `StoreUnlockSession.activate` does before the store publishes.

`BuggyUnlock` in the config is `FALSE`. That is the code. A scratch copy sets it `TRUE` so opening leaves the parked key in place and reports the second step from that key alone. TLC then finds the open vault still showing the second step. The committed config does not.

The chart labels are the words in `VaultPresentation.view.mjs`. How to rerun the check, and how to run the scratch break, is `verify-formal-vault`.

## What one step is

Each action is one snapshot the store publishes, not a line between two assignments.

| What the person sees | Where the code publishes it |
| --- | --- |
| You create a vault | `VaultStore.#persistNewVault` |
| You continue as a guest | `VaultStore.createGuest` on an empty device |
| You turn a second step on or off | second-step enrollment while the vault is open, never for a guest |
| You unlock | `VaultStore.#afterPrimaryUnwrap` |
| You enter the second step | `finishSecondStepUnlock` then `StoreUnlockSession.requireTrusted` |
| A trusted contact approves | `StoreUnlockSession.confirmTrusted` then `activate` |
| The vault locks, a challenge is cancelled, or a guest session ends | `VaultStore.lock` (also idle lock, cancel, and second-step expiry) |

## Left out

Wrong passwords, lockout counters, and which primary method was used. Password, PIN, passkey, and protector all end in `#afterPrimaryUnwrap`. The idle timer calls the same `lock`. A guest session typed beside an existing vault, and the hand-back when that guest locks, are not in the model. Neither are decoy, honey vaults, the open-lease Web Lock, or the contents of the body. The check is the published screen for one session, not a proof of the cryptography.
