import {
  GUEST_SIGN_OUT_FIRST,
  GUEST_SIGN_OUT_UNVERIFIED,
} from "@opensesame/app-core/lib/guest-auth.js";
import { inspectStoredGuestContinuation } from "@opensesame/app-core/lib/guest-continuation.js";
import { settleGuestReturnSignOut } from "@opensesame/app-core/lib/guest-return-signout.js";
import { GUEST_RETURN_EXPIRED } from "@opensesame/app-core/lib/guest-signout-copy.js";
import {
  inspectIdentityCookie,
  settleRevokes,
} from "@opensesame/app-core/lib/identity.js";
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import { signOut } from "@opensesame/app-core/lib/session-exit.js";
import { useEffect, useRef, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { StatusMark } from "../../components/StatusMark.js";

/** Give the person an explicit way to end the account found on this device. */
export function GuestSignOut({
  message,
  onDone,
  allowPendingReturn = false,
}: {
  message: string | null;
  onDone: () => void;
  allowPendingReturn?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signOutRef = useRef<HTMLButtonElement>(null);
  const pendingReturn =
    message !== null &&
    allowPendingReturn &&
    inspectStoredGuestContinuation().kind === "present";
  useEffect(() => {
    if (pendingReturn && message === GUEST_RETURN_EXPIRED)
      signOutRef.current?.focus();
  }, [message, pendingReturn]);
  if (
    message !== GUEST_SIGN_OUT_FIRST &&
    message !== GUEST_SIGN_OUT_UNVERIFIED &&
    !pendingReturn
  )
    return null;
  return (
    <>
      <p>Sign out of this tab and check Identity for browser sessions.</p>
      <button
        ref={signOutRef}
        type="button"
        className="unlock__switch"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void Promise.resolve()
            .then(() => {
              signOut();
              if (
                listNotices().some(
                  (notice) => notice.id === "session.signout-incomplete",
                )
              )
                throw new Error(
                  "Sign-out did not finish. Check browser storage and try again.",
                );
            })
            .then(settleGuestReturnSignOut)
            .then(settleRevokes)
            .then(inspectIdentityCookie)
            .then((state) => {
              if (state === "present") {
                setError(
                  "Sign-out did not finish. Check the connection or update the Identity server, then try again.",
                );
                return;
              }
              if (state === "unknown") {
                setError(
                  "Sign-out could not be verified. Check your connection or contact your administrator.",
                );
                return;
              }
              onDone();
            })
            .catch(() => setError("Sign-out did not finish. Try again."))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Signing out…" : "Sign out and check"}
      </button>
      {error ? <StatusMark tone="err" label={error} /> : null}
      <FailureNotice
        id="guest.signout"
        title="Sign-out incomplete"
        message={error}
      />
    </>
  );
}
