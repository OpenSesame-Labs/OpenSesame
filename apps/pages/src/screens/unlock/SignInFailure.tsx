import { FailureNotice } from "../../components/FailureNotice.js";
import { GuestSignOut } from "./GuestSignOut.js";

/** Offer sign-out before retrying an interrupted sign-in. */
export function SignInFailure({
  message,
  clear,
}: {
  message: string | null;
  clear: () => void;
}) {
  return (
    <>
      <FailureNotice id="unlock:sign-in" title="Sign-in" message={message} />
      <GuestSignOut message={message} onDone={clear} />
    </>
  );
}
