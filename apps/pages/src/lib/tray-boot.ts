import { atRestReady } from "@opensesame/app-core/lib/at-rest/key.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { subscribeConnectRoads } from "@opensesame/app-core/lib/connect-roads.js";
import { subscribeContributions } from "@opensesame/app-core/lib/contributions.js";
import {
  installTrayNoticePersistence,
  restoreTrayNoticeHistory,
} from "@opensesame/app-core/lib/notice-tray-persist.js";
import {
  listNotices,
  removeStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { forgetSessionTutorialPause } from "@opensesame/app-core/lib/tutorial-queue.js";
import {
  installTutorialQueueLibraryOptions,
  refreshQueuedTutorialTrayNotices,
  rehydrateTutorialQueueNotices,
} from "@opensesame/app-core/lib/tutorial-queue-present.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  MINIMAL_CONFIRM_ID,
  dismissMinimalConfirm,
} from "../screens/setup/minimal-confirm.js";
import { buildTutorialGateOptions } from "./tutorial-gate-options.js";
import { FINE_POINTER_QUERY, NARROW_QUERY } from "./use-narrow.js";

function syncTutorialQueueGate(): void {
  installTutorialQueueLibraryOptions(buildTutorialGateOptions());
}

function vaultUnlocked(): boolean {
  return vaultStore.getSnapshot().status === "unlocked";
}

/**
 * A restored Minimal confirm has the words and no act. One opened while
 * restore is still in flight already has its choices; leave that one up.
 */
function dismissRestoredMinimalConfirm(): void {
  const current = listNotices().find(
    (notice) => notice.id === MINIMAL_CONFIRM_ID,
  );
  if (!current || current.act || current.alt) return;
  dismissMinimalConfirm();
}

/** Hide queued-tour rows without dequeuing. The locked gate's Resume is inert. */
function suppressQueuedTutorialTrayRows(): void {
  for (const notice of [...listNotices()]) {
    if (!notice.id.startsWith("tutorial.queue.")) continue;
    removeStatusNotice(notice.id);
  }
}

function publishQueuedTutorialTray(): void {
  if (!vaultUnlocked()) {
    suppressQueuedTutorialTrayRows();
    return;
  }
  refreshQueuedTutorialTrayNotices();
}

function listenForDeviceForm(query: string, onChange: () => void): void {
  if (globalThis.window === undefined) return;
  let list: MediaQueryList | null = null;
  try {
    list = window.matchMedia?.(query) ?? null;
  } catch {
    list = null;
  }
  list?.addEventListener("change", onChange);
}

/** Seal tray history and restore it once the at-rest key is ready (ADR 0163). */
export function bootTrayNotices(): void {
  syncTutorialQueueGate();
  installTrayNoticePersistence();
  void atRestReady().then(() => {
    forgetSessionTutorialPause();
  });
  void restoreTrayNoticeHistory().finally(() => {
    dismissRestoredMinimalConfirm();
    if (!vaultUnlocked()) {
      suppressQueuedTutorialTrayRows();
      return;
    }
    rehydrateTutorialQueueNotices();
  });
  // Optional tutorial goals register after this module runs; re-notice the queue
  // when contributions change so restored ids gain resume keys.
  subscribeContributions(() => {
    syncTutorialQueueGate();
    publishQueuedTutorialTray();
  });
  compositionStore.subscribe(() => {
    syncTutorialQueueGate();
    publishQueuedTutorialTray();
  });
  // connectors.external publishes contributions before pagesOpen, then only
  // notifyConnectRoads(). The queue gate reads connectorTile, so that epoch
  // has to rebuild it too.
  subscribeConnectRoads(() => {
    syncTutorialQueueGate();
    publishQueuedTutorialTray();
  });
  vaultStore.subscribe(() => {
    if (!vaultUnlocked()) {
      suppressQueuedTutorialTrayRows();
      return;
    }
    syncTutorialQueueGate();
    refreshQueuedTutorialTrayNotices();
  });
  // shell.narrow and shell.keys follow the viewport and the pointer.
  const onDeviceForm = () => {
    syncTutorialQueueGate();
    publishQueuedTutorialTray();
  };
  listenForDeviceForm(NARROW_QUERY, onDeviceForm);
  listenForDeviceForm(FINE_POINTER_QUERY, onDeviceForm);
}
