import {
  installTrayNoticePersistence,
  restoreTrayNoticeHistory,
} from "@opensesame/app-core/lib/notice-tray-persist.js";
import { forgetSessionTutorialPause } from "@opensesame/app-core/lib/tutorial-queue.js";
import { rehydrateTutorialQueueNotices } from "@opensesame/app-core/lib/tutorial-queue-present.js";

/** Seal tray history and restore it once the at-rest key is ready (ADR 0163). */
export function bootTrayNotices(): void {
  // sessionStorage survives a reload. The pause is only for this document.
  forgetSessionTutorialPause();
  installTrayNoticePersistence();
  void restoreTrayNoticeHistory().finally(() => {
    rehydrateTutorialQueueNotices();
  });
}
