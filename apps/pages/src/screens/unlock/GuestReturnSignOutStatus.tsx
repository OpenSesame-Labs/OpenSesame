import {
  guestReturnSignOutSnapshot,
  restoreGuestReturnSignOut,
  retryGuestReturnSignOut,
  subscribeGuestReturnSignOut,
} from "@opensesame/app-core/lib/guest-return-signout.js";
import { useEffect, useSyncExternalStore } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconRefresh } from "../../components/Icons.js";

export function GuestReturnSignOutStatus() {
  const state = useSyncExternalStore(
    subscribeGuestReturnSignOut,
    guestReturnSignOutSnapshot,
    guestReturnSignOutSnapshot,
  );
  useEffect(() => {
    restoreGuestReturnSignOut();
  }, []);
  if (!state) return null;
  return (
    <div className="note unlock__outcome" role="status" aria-live="polite">
      <p>
        {state.error ??
          (state.complete ? "Signed out." : "Finishing guest sign-out…")}
      </p>
      {state.error ? (
        <IconKey label="Retry guest sign-out" onClick={retryGuestReturnSignOut}>
          <IconRefresh size={16} />
        </IconKey>
      ) : null}
    </div>
  );
}
