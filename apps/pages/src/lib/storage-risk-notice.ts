/**
 * The browser-storage warning, at the moments it can still change the
 * outcome: on unlock, and when the first item is sealed into a vault that
 * has no backup and no persistent-storage grant.
 *
 * The predicate is state, never a counter — items sealed, no enabled
 * backup target, and the browser has not agreed to keep this origin's
 * storage. While it holds, one standing tray notice says exactly what is
 * lost and how: clearing this site's data deletes the vault and its
 * device key with no recovery. (A plain cache clear that keeps site data
 * does not do this, and the copy never claims it does.) When the
 * predicate stops holding — a backup is enabled, storage is granted, the
 * vault locks — the notice is withdrawn. A guest tomb is ephemeral by
 * design and is never warned about; an empty vault has nothing to lose.
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
import { storagePersisted } from "./install.js";

export const STORAGE_RISK_NOTICE_ID = "vault.storage-risk";

export const storageRiskSeams = {
  getBackupStatus,
  storagePersisted,
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
): void {
  const count = liveCount(items);
  const shown = useRef(false);
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
      const [backup, persisted] = await Promise.all([
        storageRiskSeams.getBackupStatus().catch(() => null),
        storageRiskSeams.storagePersisted().catch(() => false),
      ]);
      if (!live) return;
      const backedUp = backup?.target?.enabled === true;
      if (backedUp || persisted) {
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
        open: { to: "/vault?f=all", label: "Export a copy" },
      });
    })();
    return () => {
      live = false;
    };
  }, [status, tomb, guest, count]);
}
