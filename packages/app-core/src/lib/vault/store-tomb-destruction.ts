/** Destruction queues behind writes, then takes the original OPEN/BODY lease order. */

import { isIsolatedGuestVaultId } from "../guest-vault-id.js";
import { kvDeleteDurable } from "../kv.js";
import { HEADER_PATH, deletePlaintextFile, vfsFlush } from "../vfs.js";
import { releaseRetiredTransientGuest } from "../vfs-transient-guest.js";
import type { VaultScope } from "./store-scope.js";
import type { StoreWriteQueue } from "./store-write-queue.js";
import { discardVaultBody, wipeTombOnDestroy } from "./tomb-migration.js";
import {
  acquireExclusiveGuestLease,
  withBodyWriteLock,
  withExclusiveOpenLease,
} from "./vault-shared-locks.js";

/** Retrying a failed temporary cleanup must never target the restored vault. */
export class GuestDestroyRetry {
  #pending: { target: VaultScope; returned: VaultScope } | null = null;

  select(scope: VaultScope, transient: boolean, unlocked: boolean) {
    const previous = this.#pending;
    this.#pending = null;
    return !transient && !unlocked && previous?.returned === scope
      ? { scope: previous.target, transient: true }
      : { scope, transient };
  }

  remember(target: VaultScope, returned: VaultScope) {
    const pending = { target, returned };
    this.#pending = pending;
    return pending;
  }

  complete(pending: { target: VaultScope; returned: VaultScope }): void {
    if (this.#pending === pending) this.#pending = null;
  }
}

export async function destroyStoredTomb(
  queue: StoreWriteQueue,
  scope: VaultScope,
  transient = false,
): Promise<void> {
  const done = queue
    .pending()
    .catch(() => undefined)
    .then(async () => {
      // Locking a guest first drains and revokes its return before releasing
      // the exclusive guest lease. Finish that cleanup before reacquiring it.
      if (isIsolatedGuestVaultId(scope.tomb)) await vfsFlush();
      if (transient) {
        // A temporary guest owns only its in-document storage. It must never
        // delete durable files, even if its generated tomb name collides. The
        // lease proves revocation finished before reporting success.
        const release = await acquireExclusiveGuestLease(
          scope.tomb,
          false,
        ).catch(() => {
          throw new Error(
            "Could not end this guest session. Keep this tab open, close any other tabs using this guest, and retry.",
          );
        });
        try {
          releaseRetiredTransientGuest(scope.tomb);
        } finally {
          await release();
        }
        return;
      }
      return withExclusiveOpenLease(scope.tomb, () =>
        withBodyWriteLock(scope.tomb, async () => {
          if (isIsolatedGuestVaultId(scope.tomb)) {
            releaseRetiredTransientGuest(scope.tomb);
          }
          // The header is the tomb's recoverability marker. Delete it last:
          // a failed body or key wipe must leave a header that still says a
          // vault exists, never an empty store a later create can overwrite.
          // Its shared-index refresh must finish before the wipe deletes it.
          await discardVaultBody(scope.tomb);
          await Promise.all([
            kvDeleteDurable(scope.attempts),
            wipeTombOnDestroy(scope.tomb),
          ]);
          await deletePlaintextFile(scope.tomb, HEADER_PATH);
        }),
      );
    });
  queue.assign(done);
  await done;
}
