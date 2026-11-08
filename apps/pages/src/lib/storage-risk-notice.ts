/**
 * The browser-storage warning, at the moments it can still change the
 * outcome: on unlock, and when the first item is sealed into a vault that
 * has no working backup.
 *
 * The predicate is state, never a counter — items sealed and no backup
 * target that is enabled, error-free and caught up. While it holds, one
 * standing tray notice says exactly what is lost and how: clearing this
 * site's data deletes the vault and its device key with no recovery.
 * (A plain cache clear that keeps site data does not do this, and the
 * copy never claims it does. A persistent-storage grant does not save
 * the vault either — it only stays the browser's own eviction, never a
 * person's delete — so it never silences the warning.) When the
 * predicate stops holding — a backup is working, the vault locks — the
 * notice is withdrawn. A guest tomb is ephemeral by design and is never
 * warned about; an empty vault has nothing to lose.
 *
 * The notice's own act opens the export sheet in place, so following the
 * advice takes one press, not a hunt through the vault for the key.
 *
 * Nothing is persisted to remember the warning was shown: it derives from
 * the vault's own state on every unlock, so there is no nag flag to seal.
 */

import { getBackupStatus } from "@opensesame/app-core/lib/backup.js";
import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import type { VaultItem } from "@opensesame/vault-core";
import { useEffect, useRef } from "react";

export const STORAGE_RISK_NOTICE_ID = "vault.storage-risk";

export const storageRiskSeams = {
  getBackupStatus,
  setStatusNotice,
  dismissNotice,
};

function liveCount(items: readonly VaultItem[] | undefined): number {
  if (!items) return 0;
  return items.filter((item) => item.deletedAt === null).length;
}

export function useStorageRiskNotice(
  status: string,
  tomb: string | undefined,
  items: readonly VaultItem[] | undefined,
  guest = false,
  onExport?: (() => void) | undefined,
): void {
  const count = liveCount(items);
  const shown = useRef(false);
  const exportRef = useRef(onExport);
  exportRef.current = onExport;
  useEffect(() => {
    if (status !== "unlocked" || !tomb || guest || count === 0) {
      if (shown.current) {
        shown.current = false;
        storageRiskSeams.dismissNotice(STORAGE_RISK_NOTICE_ID);
      }
      return;
    }
    let live = true;
    void (async () => {
      const backup = await storageRiskSeams.getBackupStatus().catch(() => null);
      if (!live) return;
      // Enabled is not backed up: a target that is failing, or still
      // holding unsynced events, has not kept what the vault sealed.
      const backedUp =
        backup?.target?.enabled === true &&
        backup.target.lastError === null &&
        backup.pendingEvents === 0;
      if (backedUp) {
        if (shown.current) {
          shown.current = false;
          storageRiskSeams.dismissNotice(STORAGE_RISK_NOTICE_ID);
        }
        return;
      }
      shown.current = true;
      storageRiskSeams.setStatusNotice({
        id: STORAGE_RISK_NOTICE_ID,
        tone: "warn",
        title: "This vault lives only in this browser",
        body: "Clearing this site's data in your browser settings deletes the vault and its device key — there is no recovery, and no copy anywhere else yet. Export an encrypted copy now, and set up a backup so new items are kept too.",
        ...(exportRef.current
          ? {
              act: {
                label: "Export a copy",
                run: () => exportRef.current?.(),
              },
            }
          : { open: { to: "/vault?f=all", label: "Export a copy" } }),
      });
    })();
    return () => {
      live = false;
    };
  }, [status, tomb, guest, count]);
}
