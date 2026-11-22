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
export const KEEP_DEFAULT_SETUP = "Keep Default";

const MINIMAL_WARNING_BODY =
  "You give up password, passkey, card, and note types until you turn them on in settings.";

export function dismissMinimalConfirm(): void {
  hideToast(MINIMAL_CONFIRM_ID);
  dismissNotice(MINIMAL_CONFIRM_ID);
}

/** Sticky toast and a matching tray notice. Dismiss leaves the choice open. */
export function showMinimalConfirm(
  confirm: () => void,
  keepDefault: () => void,
): void {
  const run = () => {
    dismissMinimalConfirm();
    confirm();
  };
  const stay = () => {
    dismissMinimalConfirm();
    keepDefault();
  };
  showToast({
    id: MINIMAL_CONFIRM_ID,
    tone: "warn",
    title: "Minimal",
    body: MINIMAL_WARNING_BODY,
    sticky: true,
    choice: { label: USE_MINIMAL_ANYWAY, run },
    alt: { label: KEEP_DEFAULT_SETUP, run: stay },
  });
  setStatusNotice({
    id: MINIMAL_CONFIRM_ID,
    tone: "warn",
    title: "Minimal",
    body: MINIMAL_WARNING_BODY,
    act: { label: USE_MINIMAL_ANYWAY, worded: true, run },
    alt: { label: KEEP_DEFAULT_SETUP, worded: true, run: stay },
  });
}
