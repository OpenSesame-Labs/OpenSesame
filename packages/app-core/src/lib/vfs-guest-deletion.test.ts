import { overlapCast } from "@opensesame/os-domain";
import { mintVaultKey, vaultSealBinding } from "@opensesame/vault-core";
import { afterEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { makeOpfs } from "./duress/wipe/fake-opfs.test-support.js";
import { newGuestVaultId } from "./guest-vault-id.js";
import { kvFileName, kvForgetAll, kvSetDurable } from "./kv.js";
import {
  deleteFile,
  listDir,
  lockTomb,
  readFile,
  recoverGuestDeletion,
  tombFileKey,
  unlockTomb,
  vfsFlush,
  vfsSeams,
  writeFile,
} from "./vfs.js";
import { GUEST_DELETE_JOURNAL } from "./vfs-guest-deletion.js";

afterEach(async () => {
  await vfsFlush();
  vi.restoreAllMocks();
  kvForgetAll();
  configureHost(createTestHost());
});

async function seedJournal(tomb: string, key: CryptoKey): Promise<void> {
  const blob = await vfsSeams.seal(
    key,
    { v: 1, idle: true },
    vaultSealBinding(tomb, GUEST_DELETE_JOURNAL),
  );
  await kvSetDurable(
    tombFileKey(tomb, GUEST_DELETE_JOURNAL),
    JSON.stringify(blob),
  );
}

it.each(["before", "after"])(
  "recovers an interrupted deletion %s the file was removed",
  async (boundary) => {
    const root = makeOpfs();
    configureHost(
      createTestHost({
        locks: webLocksDouble(),
        originFiles: async () => overlapCast(root),
      }),
    );
    const tomb = newGuestVaultId();
    const { vaultKey, rawVaultKey } = await mintVaultKey();
    rawVaultKey.fill(0);
    unlockTomb(tomb, vaultKey);
    await seedJournal(tomb, vaultKey);
    await writeFile(
      tomb,
      "config/credential",
      new TextEncoder().encode("secret"),
    );
    const remove = vfsSeams.deleteRawGuarded;
    if (!remove) throw new Error("Missing guarded delete");
    let interrupted = false;
    vi.spyOn(vfsSeams, "deleteRawGuarded").mockImplementation(
      async (key, check) => {
        if (!interrupted && key === tombFileKey(tomb, "config/credential")) {
          interrupted = true;
          if (boundary === "after") await remove(key, check);
          throw new Error("interrupted deletion");
        }
        return remove(key, check);
      },
    );
    await expect(deleteFile(tomb, "config/credential")).rejects.toThrow(
      "interrupted deletion",
    );
    lockTomb(tomb);
    kvForgetAll();
    unlockTomb(tomb, vaultKey);
    await recoverGuestDeletion(tomb, () => {});
    expect(await listDir(tomb, "config")).toEqual([]);
    await expect(readFile(tomb, "config/credential")).rejects.toMatchObject({
      code: "not-found",
    });
    lockTomb(tomb);
  },
);

it("keeps a valid idle journal if opening a replacement fails", async () => {
  const root = makeOpfs();
  configureHost(
    createTestHost({
      locks: webLocksDouble(),
      originFiles: async () => overlapCast(root),
    }),
  );
  const tomb = newGuestVaultId();
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  unlockTomb(tomb, vaultKey);
  await seedJournal(tomb, vaultKey);
  await writeFile(
    tomb,
    "config/credential",
    new TextEncoder().encode("secret"),
  );
  const journal = kvFileName(tombFileKey(tomb, GUEST_DELETE_JOURNAL));
  const before = root.files.get(journal);
  const getFileHandle = root.getFileHandle.bind(root);
  let fail = true;
  vi.spyOn(root, "getFileHandle").mockImplementation(async (name, options) => {
    const handle = await getFileHandle(name, options);
    if (name !== journal || !options?.create || !fail) return handle;
    fail = false;
    return {
      ...handle,
      createWritable: async () => {
        throw new Error("quota");
      },
    };
  });
  await expect(deleteFile(tomb, "config/credential")).rejects.toThrow("quota");
  expect(root.files.get(journal)).toBe(before);
  lockTomb(tomb);
  kvForgetAll();
  unlockTomb(tomb, vaultKey);
  await recoverGuestDeletion(tomb, () => {});
  await vfsSeams.refreshRaw?.(tombFileKey(tomb, "config/credential"), 65536);
  expect(
    new TextDecoder().decode(await readFile(tomb, "config/credential")),
  ).toBe("secret");
  lockTomb(tomb);
});
