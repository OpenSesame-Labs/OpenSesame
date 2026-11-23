import { isGuestVaultId } from "./guest-vault-id.js";
import { readGuestSessionPerson } from "./local-guest.js";
import { vaultStore } from "./vault/store.js";

/** GitHub operations for a guest remain bound to its own vault and actor. */
export function guestGithubSessionGuard() {
  const snapshot = vaultStore.getSnapshot();
  const person = readGuestSessionPerson();
  if (
    snapshot.status !== "unlocked" ||
    snapshot.decoy ||
    !isGuestVaultId(snapshot.tomb) ||
    !person
  )
    throw new Error("Unlock the guest vault first.");
  let ended = false;
  const stop = vaultStore.onLock(() => {
    ended = true;
  });
  return {
    current() {
      const current = vaultStore.getSnapshot();
      if (
        ended ||
        current.status !== "unlocked" ||
        current.decoy ||
        current.tomb !== snapshot.tomb ||
        readGuestSessionPerson()?.id !== person.id
      )
        throw new Error("The guest session ended. Connect again.");
      return current;
    },
    close() {
      ended = true;
      stop();
    },
  };
}
