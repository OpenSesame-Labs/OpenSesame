import { FailureNotice } from "../../components/FailureNotice.js";
import { GuestSignOut } from "./GuestSignOut.js";

export function UnlockErrors({
  title,
  message,
  clear,
  guestKeyless,
}: {
  title: string;
  message: string | null;
  clear: () => void;
  guestKeyless: boolean;
}) {
  return (
    <>
      <FailureNotice id="unlock:error" title={title} message={message} />
      <GuestSignOut
        message={message}
        onDone={clear}
        allowPendingReturn={guestKeyless}
      />
    </>
  );
}
