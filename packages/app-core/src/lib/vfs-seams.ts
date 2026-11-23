/** The ordinary VFS initializes its unchanged singleton without reading ports at import. */
import { openJson, sealJson } from "@opensesame/vault-core";
import { kvDeleteDurable, kvGet, kvRefresh, kvSetDurable } from "./kv.js";
import { type VfsSeams, vfsSeams as installed } from "./vfs-seams-state.js";
import {
  deleteTransientGuest,
  isReadableTransientGuestKey,
  isTransientGuestKey,
  readTransientGuest,
  writeTransientGuest,
} from "./vfs-transient-guest.js";

export type { VfsSeams } from "./vfs-seams-state.js";
export const vfsSeams: VfsSeams = Object.assign(installed, {
  readRaw: (key: string) =>
    isReadableTransientGuestKey(key) ? readTransientGuest(key) : kvGet(key),
  writeRaw: async (key: string, value: string) => {
    if (isTransientGuestKey(key) && (await writeTransientGuest(key, value)))
      return;
    await kvSetDurable(key, value);
  },
  writeRawGuarded: async (
    key: string,
    value: string,
    beforeCommit: () => void,
    _vaultKey?: CryptoKey,
  ) => {
    if (
      isTransientGuestKey(key) &&
      (await writeTransientGuest(key, value, beforeCommit))
    )
      return;
    await kvSetDurable(key, value, beforeCommit);
  },
  deleteRaw: async (key: string) => {
    if (isTransientGuestKey(key) && (await deleteTransientGuest(key))) return;
    await kvDeleteDurable(key);
  },
  deleteRawGuarded: async (key: string, beforeCommit: () => void) => {
    if (
      isTransientGuestKey(key) &&
      (await deleteTransientGuest(key, beforeCommit))
    )
      return;
    await kvDeleteDurable(key, beforeCommit);
  },
  refreshRaw: (key: string, maxBytes: number, check?: () => void) => {
    if (!isReadableTransientGuestKey(key))
      return kvRefresh(key, maxBytes, check);
    check?.();
    return Promise.resolve();
  },
  seal: sealJson,
  open: openJson,
});
