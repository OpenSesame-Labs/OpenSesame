/** Original checked publication effects only; never an owner or admission issuer. */
import type { VaultHeader } from "@opensesame/vault-core";
import { DECOY_SCRATCH_TOMB } from "../duress/store/decoy-scratch.js";
import { HEADER_PATH, readPlaintextFile, writePlaintextFile } from "../vfs.js";

/** The scratch tomb is erased whenever a session ends or another opens. */
export const TEMPORARY_GUEST_PROTECTION_MESSAGE =
  "This temporary guest vault cannot be protected. Its items are erased when it locks.";

/** A root turn carries the current BODY witness into its final HEADER. */
export function withBodyWitness(
  previous: VaultHeader | null,
  next: VaultHeader,
): VaultHeader {
  const witness = previous?.bodyRev ?? 0;
  return witness > (next.bodyRev ?? 0) ? { ...next, bodyRev: witness } : next;
}

export async function publishOriginalHeader(
  tomb: string,
  text: () => string,
  previous: string | null,
  check: () => void,
  prepare: () => Promise<void>,
  failed: (unchangedPhysical: boolean) => void,
): Promise<void> {
  try {
    // A key enrolled here would seal a vault the next guest wipes.
    if (tomb === DECOY_SCRATCH_TOMB)
      throw new Error(TEMPORARY_GUEST_PROTECTION_MESSAGE);
    check();
    await prepare();
    check();
    await writePlaintextFile(tomb, HEADER_PATH, text(), check);
    check();
  } catch (error) {
    check();
    failed(readPlaintextFile(tomb, HEADER_PATH) === previous);
    throw error;
  }
}

export { bindOriginalHeaderPolicy } from "./store-header-binding-data.js";
