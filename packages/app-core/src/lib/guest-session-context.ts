import { assertGuestReturnEpoch } from "./guest-return-epoch.js";

/** Current in-document guest scope; never a credential or persisted identity. */
let active: string | null = null;
let activeEpoch: string | null = null;
let localOnly = false;
let generation = 0;

export function activeGuestTomb(): string | null {
  return active;
}

export function activateGuestTomb(
  tomb: string,
  epoch: string | null,
  restricted = false,
): void {
  generation += 1;
  active = tomb;
  activeEpoch = epoch;
  localOnly = restricted || epoch === null;
}

export function retireGuestTomb(tomb: string): void {
  if (active === tomb) {
    active = null;
    activeEpoch = null;
    localOnly = false;
    generation += 1;
  }
}

/** A lock and re-unlock of the same tomb is still a different session. */
export function captureGuestSessionContext(): (() => boolean) | null {
  const tomb = active;
  const original = generation;
  const epoch = activeEpoch;
  return tomb === null
    ? null
    : () => {
        if (active !== tomb || generation !== original) return false;
        if (epoch === null) return true;
        try {
          assertGuestReturnEpoch(epoch);
          return true;
        } catch {
          return false;
        }
      };
}

/** The generation captured when this guest began opening. */
export function activeGuestEpoch(): string | null {
  return activeEpoch;
}

export function isLocalOnlyGuest(): boolean {
  return active !== null && localOnly;
}
