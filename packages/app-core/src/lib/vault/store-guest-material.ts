/** Existing synthetic/guest-only creation data. Cannot produce a real principal. */
import { type VaultHeader, mintVaultKey } from "@opensesame/vault-core";
import {
  decoyScratchScope,
  isGuestSessionTomb,
  markDecoySession,
} from "../duress/store/decoy-scratch.js";
import { retireGuestTomb } from "../guest-session-context.js";
import { isIsolatedGuestVaultId, newGuestVaultId } from "../guest-vault-id.js";
import { writeLastVaultId } from "../last-vault.js";
import {
  type GuestSessionPerson,
  clearIsolatedGuestPerson,
  prepareIsolatedGuestPerson,
} from "../local-guest.js";
import { dismissNotice, setStatusNotice } from "../notices.js";
import { GUEST_TOMB, lockTomb } from "../vfs.js";
import {
  beginTransientGuest,
  discardUnpublishedTransientGuest,
  releaseRetiredTransientGuest,
} from "../vfs-transient-guest.js";
import { flushTombWrites, trackVfsCleanup } from "../vfs-write-order.js";
import { guestVaultScope } from "./store-scope.js";
import { discardVaultBody, wipeTombOnDestroy } from "./tomb-migration.js";
import { acquireExclusiveGuestLease } from "./vault-shared-locks.js";
export type GuestCreationOptions = {
  resume?: boolean;
  decoy?: boolean;
  scratch?: true;
  /** An actor prepared for this session; only published with the open vault. */
  guestPerson?: GuestSessionPerson;
  localOnly?: boolean;
};

export function guestActor(
  person: GuestSessionPerson | null,
  epoch: string | null,
  options?: GuestCreationOptions,
): GuestSessionPerson | null {
  return person && (options?.localOnly || epoch === null)
    ? { ...person, localOnly: true }
    : person;
}

export function retireGuestSession(
  tomb: string,
  identity: symbol | null,
): void {
  retireGuestTomb(tomb);
  if (identity) clearIsolatedGuestPerson(identity);
}

type Lease = { tomb: string; release: () => Promise<void> };

/** Keep the exclusive lease until this guest's queued writes have settled. */
export function releaseGuestLease(
  lease: Lease,
  storeWrites: Promise<void>,
): void {
  const id = `guest.lease-release.${lease.tomb}`;
  const attempt = async () => {
    try {
      await storeWrites.catch(() => undefined);
      await flushTombWrites(lease.tomb);
      releaseRetiredTransientGuest(lease.tomb);
      await lease.release();
      dismissNotice(id);
    } catch {
      setStatusNotice({
        id,
        tone: "err",
        title: "Connection could not be closed",
        body: "Keep this tab open and retry to finish ending the guest connection.",
        retry: () => {
          trackVfsCleanup(attempt());
        },
        transient: true,
      });
    }
  };
  trackVfsCleanup(attempt());
}

export async function abandonPreparedGuest(
  opened: Awaited<ReturnType<typeof prepareGuestOpen>>,
  abandon: (lease: Lease | null) => Promise<void>,
): Promise<void> {
  opened.prepared.rawVaultKey.fill(0);
  if (opened.transient)
    discardUnpublishedTransientGuest(opened.scope.tomb, opened.transient);
  await abandon(opened.lease);
}
/** Prepare all resources before publishing a guest into the store. */
export async function prepareGuestOpen(
  options: GuestCreationOptions | undefined,
  check: () => void,
  acquire: (tomb: string) => Promise<Lease | null>,
  abandon: (lease: Lease | null) => Promise<void>,
) {
  const person = options?.decoy
    ? null
    : (options?.guestPerson ?? (await prepareIsolatedGuestPerson()));
  check();
  const scope = selectGuestScope(options);
  let transient: symbol | null = null;
  let lease: Lease | null = null;
  let prepared: Awaited<ReturnType<typeof prepareGuestMaterial>> | null = null;
  try {
    lease = isIsolatedGuestVaultId(scope.tomb)
      ? {
          tomb: scope.tomb,
          release: await acquireExclusiveGuestLease(scope.tomb, false),
        }
      : await acquire(scope.tomb);
    check();
    transient = isIsolatedGuestVaultId(scope.tomb)
      ? beginTransientGuest(scope.tomb)
      : null;
    prepared = await prepareGuestMaterial(scope.tomb, options, check);
    check();
    return { person, scope, transient, lease, prepared };
  } catch (error) {
    await abandon(lease);
    prepared?.rawVaultKey.fill(0);
    if (transient) discardUnpublishedTransientGuest(scope.tomb, transient);
    throw error;
  }
}

export function selectGuestScope(options?: GuestCreationOptions) {
  markDecoySession(options?.decoy === true);
  if (!options?.decoy) {
    const tomb = newGuestVaultId();
    if (!isIsolatedGuestVaultId(tomb))
      throw new Error("Invalid guest session.");
    return guestVaultScope(tomb);
  }
  // A decoy also never wipes the legacy guest tomb based on a cached header.
  return decoyScratchScope();
}
export async function prepareGuestMaterial(
  tomb: string,
  _options?: GuestCreationOptions,
  check: () => void = () => {},
) {
  if (!isGuestSessionTomb(tomb))
    throw new Error("Guest material requires an isolated tomb.");
  if (isIsolatedGuestVaultId(tomb)) {
    check();
    return mintGuestMaterial();
  }
  // A previous guest's leftovers are ciphertext under a dead tab's key — unreadable, in the way.
  lockTomb(tomb);
  await wipeTombOnDestroy(tomb);
  await discardVaultBody(tomb);
  return mintGuestMaterial();
}

async function mintGuestMaterial() {
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  const header: VaultHeader = { v: 1, createdAt: new Date().toISOString() };
  return { header, vaultKey, rawVaultKey };
}

export function recordGuestOrigin(options?: GuestCreationOptions): void {
  // A decoy leaves the unlock screen on the vault it was typed at.
  if (!options?.decoy) writeLastVaultId(GUEST_TOMB);
}
