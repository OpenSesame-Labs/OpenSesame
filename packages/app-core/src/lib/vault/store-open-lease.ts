import { originFiles } from "../../ports.js";
import { atRestSettled } from "../at-rest/key.js";
import { isIsolatedGuestVaultId } from "../guest-vault-id.js";
import {
  acquireExclusiveGuestLease,
  acquireOpenLease,
} from "./vault-shared-locks.js";

/** Keep a protected guest exclusive; ordinary vaults share an open lease. */
export async function acquireGuestAwareLease(tomb: string) {
  return {
    tomb,
    release: isIsolatedGuestVaultId(tomb)
      ? await acquireExclusiveGuestLease(
          tomb,
          Boolean(atRestSettled()?.durable !== false && originFiles()),
        )
      : await acquireOpenLease(tomb),
  };
}
