/** Cryptographic bindings used by the file-backed body mirror. */
import {
  type SealedBlob,
  type VaultBody,
  openJson,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { BODY_PATH } from "../vfs.js";
import type { TombProjection } from "./secret-docs.js";

const bodyBinding = (tomb: string) => vaultSealBinding(tomb, BODY_PATH);
const PROBE_BINDING = "secret-fs/key-probe";

export const openBodyBlob = (tomb: string, key: CryptoKey, blob: SealedBlob) =>
  openJson<VaultBody>(key, blob, bodyBinding(tomb));
export const sealBodyBlob = (tomb: string, key: CryptoKey, body: VaultBody) =>
  sealJson(key, body, bodyBinding(tomb));
export const probeFor = (key: CryptoKey): Promise<SealedBlob> =>
  sealJson(key, { probe: 1 }, PROBE_BINDING);

/** Whether the remembered documents were sealed under this key. */
export async function sealedUnder(
  held: TombProjection,
  key: CryptoKey,
): Promise<boolean> {
  if (held.sealedProbe === undefined) return false;
  try {
    await openJson(key, held.sealedProbe, PROBE_BINDING);
    return true;
  } catch {
    return false;
  }
}
