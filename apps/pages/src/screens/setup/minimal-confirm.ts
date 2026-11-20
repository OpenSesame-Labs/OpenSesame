/**
 * Minimal is the advanced road. Choosing it asks once, in the toast and the
 * tray, and does not commit until "Use Minimal anyway".
 */

import { hideToast, showToast } from "@opensesame/app-core/lib/notice-toast.js";
import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";

export const MINIMAL_CONFIRM_ID = "setup.minimal.confirm";
export const USE_MINIMAL_ANYWAY = "Use Minimal anyway";

export function dismissMinimalConfirm(): void {
  hideToast(MINIMAL_CONFIRM_ID);
  dismissNotice(MINIMAL_CONFIRM_ID);
}

/** Sticky toast and a matching tray notice. Dismiss leaves the choice open. */
export function showMinimalConfirm(confirm: () => void): void {
  const run = () => {
    dismissMinimalConfirm();
    confirm();
  };
  showToast({
    id: MINIMAL_CONFIRM_ID,
    tone: "warn",
    title: "Minimal",
    body: "Advanced. Plain secrets and files only.",
    sticky: true,
    choice: { label: USE_MINIMAL_ANYWAY, run },
  });
  setStatusNotice({
    id: MINIMAL_CONFIRM_ID,
    tone: "warn",
    title: "Minimal",
    body: "Advanced. Plain secrets and files only.",
    act: { label: USE_MINIMAL_ANYWAY, worded: true, run },
  });
}
