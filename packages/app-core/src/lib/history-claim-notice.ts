/**
 * Guest-claim bell copy. History backups no longer mint a second account.
 */

import { setStatusNotice } from "./notices.js";

const GUEST_NOTICE_TITLE = "Claim this guest session";
const GUEST_NOTICE_BODY =
  "You skipped registered sign-in. Sign in with a trusted account to attach it to this principal — the id stays the same.";

export { GUEST_NOTICE_BODY, GUEST_NOTICE_TITLE };

/** Said out loud, never silent: no session survived on this device, so this sign-in stands on a principal created for it just now. */
export function announceMintedIdentity(): void {
  setStatusNotice({
    id: "federated.new-identity",
    tone: "info",
    title: "New OpenSesame identity",
    body: "This sign-in created a new OpenSesame identity on this device, because no earlier session was found here to attach it to. If you already have an identity with a vault on this device, unlock that vault and attach this sign-in from there instead.",
  });
}
