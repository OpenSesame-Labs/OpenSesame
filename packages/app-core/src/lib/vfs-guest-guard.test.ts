import { mintVaultKey } from "@opensesame/vault-core";
import { expect, it } from "vitest";
import {
  lockTomb,
  unlockTomb,
  vfsSeams,
  writeFile,
  writePlaintextFile,
} from "./vfs.js";

it("uses the guarded guest transport even when a plaintext caller omits its callback", async () => {
  const tomb = `guest_${crypto.randomUUID()}`;
  const oldGuard = vfsSeams.writeRawGuarded;
  const oldWrite = vfsSeams.writeRaw;
  let unguarded = 0;
  vfsSeams.writeRawGuarded = async () => {
    throw new Error("Guard refused");
  };
  vfsSeams.writeRaw = async () => {
    unguarded++;
  };
  try {
    await expect(writePlaintextFile(tomb, "header", "fixture")).rejects.toThrow(
      "Guard refused",
    );
    expect(unguarded).toBe(0);
  } finally {
    vfsSeams.writeRaw = oldWrite;
    if (oldGuard) vfsSeams.writeRawGuarded = oldGuard;
    else Reflect.deleteProperty(vfsSeams, "writeRawGuarded");
  }
});

it("refuses a guest sealed write without guarded storage, even without a callback", async () => {
  const tomb = `guest_${crypto.randomUUID()}`;
  const previous = { ...vfsSeams };
  Reflect.deleteProperty(vfsSeams, "writeRawGuarded");
  Reflect.deleteProperty(vfsSeams, "guestWriteRawGuarded");
  Reflect.deleteProperty(vfsSeams, "writeOwnedMetadata");
  let unguarded = 0;
  vfsSeams.writeRaw = async () => {
    unguarded++;
  };
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  unlockTomb(tomb, vaultKey);
  try {
    await expect(
      writeFile(tomb, "config/test", new Uint8Array()),
    ).rejects.toThrow(/cannot commit an original-owner/);
    expect(unguarded).toBe(0);
  } finally {
    lockTomb(tomb);
    Object.assign(vfsSeams, previous);
  }
});
