import { atRestReady } from "@opensesame/app-core/lib/at-rest/key.js";
import { subscribeContributions } from "@opensesame/app-core/lib/contributions.js";
import {
  installTrayNoticePersistence,
  restoreTrayNoticeHistory,
} from "@opensesame/app-core/lib/notice-tray-persist.js";
import { forgetSessionTutorialPause } from "@opensesame/app-core/lib/tutorial-queue.js";
import {
  refreshQueuedTutorialTrayNotices,
  rehydrateTutorialQueueNotices,
} from "@opensesame/app-core/lib/tutorial-queue-present.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { dismissMinimalConfirm } from "../screens/setup/minimal-confirm.js";

/** Seal tray history and restore it once the at-rest key is ready (ADR 0163). */
export function bootTrayNotices(): void {
  installTrayNoticePersistence();
  void atRestReady().then(() => {
    forgetSessionTutorialPause();
  });
  void restoreTrayNoticeHistory().finally(() => {
    dismissMinimalConfirm();
    rehydrateTutorialQueueNotices();
  });
  // Optional tutorial goals register after this module runs; re-notice the queue
  // when contributions change so restored ids gain resume keys.
  subscribeContributions(() => {
    refreshQueuedTutorialTrayNotices();
  });
  let vaultStatus = vaultStore.getSnapshot().status;
  vaultStore.subscribe(() => {
    const status = vaultStore.getSnapshot().status;
    if (vaultStatus !== "unlocked" && status === "unlocked") {
      refreshQueuedTutorialTrayNotices();
    }
    vaultStatus = status;
  });
}
