import {
  createItem,
  emptyBody,
  mintVaultKey,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { deferred } from "../vault/store-unlock-races.fixture.js";
import {
  BODY_PATH,
  deleteFile,
  lockTomb,
  tombFileKey,
  unlockTomb,
  vfsSeams,
  writeFile,
  writeSealedFile,
} from "../vfs.js";
import type { SecretFiles } from "./files.js";
import { installFileBackedVfs } from "./install.js";
import { makeMemorySecretFiles } from "./memory.js";
import { createFileBackedVfs } from "./vfs-files.js";

const tomb = "delete-owner";
const path = "config/owned";
const physical = `${tomb}/${path}.json`;
const text = new TextEncoder().encode("fixture");

it("does not let a queued delete adopt a new unlock using the same key", async () => {
  const entered = deferred();
  const release = deferred();
  const disk = makeMemorySecretFiles();
  const restore = await installFileBackedVfs(disk);
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  unlockTomb(tomb, vaultKey);
  await writeFile(tomb, path, text);
  const before = vfsSeams.readRaw(tombFileKey(tomb, path));
  const seal = vfsSeams.seal;
  vfsSeams.seal = async (...args) => {
    const blob = await seal(...args);
    entered.release();
    await release.promise;
    return blob;
  };
  const writing = writeFile(tomb, "config/blocker", text).then(
    () => null,
    (error: Error) => error,
  );
  await entered.promise;
  const deleting = deleteFile(tomb, path).then(
    () => null,
    (error: Error) => error,
  );
  try {
    lockTomb(tomb);
    unlockTomb(tomb, vaultKey);
    release.release();
    expect(await writing).toBeInstanceOf(Error);
    expect(await deleting).toBeInstanceOf(Error);
    expect(disk.snapshot().has(physical)).toBe(true);
    expect(vfsSeams.readRaw(tombFileKey(tomb, path))).toBe(before);
    vfsSeams.seal = seal;
    await deleteFile(tomb, path);
    expect(disk.snapshot().has(physical)).toBe(false);
    expect(vfsSeams.readRaw(tombFileKey(tomb, path))).toBeNull();
  } finally {
    release.release();
    vfsSeams.seal = seal;
    lockTomb(tomb);
    restore();
  }
});

it("does not physically delete or publish a mirror after an owner is replaced", async () => {
  const entered = deferred();
  const release = deferred();
  const disk = makeMemorySecretFiles();
  const guarded = disk.removeGuarded?.bind(disk);
  if (!guarded) throw new Error("Missing guarded removal fixture");
  const files: SecretFiles = {
    ...disk,
    removeGuarded(file, check, options) {
      if (file !== physical) return guarded(file, check, options);
      return Effect.promise(async () => {
        entered.release();
        await release.promise;
      }).pipe(Effect.flatMap(() => guarded(file, check, options)));
    },
  };
  const restore = await installFileBackedVfs(files);
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  unlockTomb(tomb, vaultKey);
  await writeFile(tomb, path, text);
  const before = vfsSeams.readRaw(tombFileKey(tomb, path));
  const deleting = deleteFile(tomb, path).then(
    () => null,
    (error: Error) => error,
  );
  try {
    await entered.promise;
    lockTomb(tomb);
    unlockTomb(tomb, vaultKey);
    release.release();
    expect(await deleting).toBeInstanceOf(Error);
    expect(disk.snapshot().has(physical)).toBe(true);
    expect(vfsSeams.readRaw(tombFileKey(tomb, path))).toBe(before);
  } finally {
    release.release();
    lockTomb(tomb);
    restore();
  }
});

it("refuses ordinary deletion when guarded removal is unavailable", async () => {
  const disk = makeMemorySecretFiles();
  const { removeGuarded: _missing, ...files } = disk;
  const restore = await installFileBackedVfs(files);
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  unlockTomb(tomb, vaultKey);
  try {
    await writeFile(tomb, path, text);
    expect(vfsSeams.deleteOwnedFile).toBeUndefined();
    await expect(deleteFile(tomb, path)).rejects.toThrow(
      /original-owner deletion/,
    );
    expect(disk.snapshot().has(physical)).toBe(true);
  } finally {
    lockTomb(tomb);
    restore();
  }
});

it("guards every physical file when deleting a projected body", async () => {
  const entered = deferred();
  const release = deferred();
  const disk = makeMemorySecretFiles();
  const guarded = disk.removeGuarded?.bind(disk);
  if (!guarded) throw new Error("Missing guarded removal fixture");
  const files: SecretFiles = {
    ...disk,
    removeGuarded(file, check, options) {
      if (!file.includes("/secrets/")) return guarded(file, check, options);
      return Effect.promise(async () => {
        entered.release();
        await release.promise;
      }).pipe(Effect.flatMap(() => guarded(file, check, options)));
    },
  };
  const restore = await installFileBackedVfs(files);
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  const body = { ...emptyBody(), items: [createItem("note", "fixture")] };
  const blob = await sealJson(
    vaultKey,
    body,
    vaultSealBinding(tomb, BODY_PATH),
  );
  unlockTomb(tomb, vaultKey);
  await writeSealedFile(tomb, BODY_PATH, blob);
  const deleting = deleteFile(tomb, BODY_PATH).then(
    () => null,
    (error: Error) => error,
  );
  try {
    await entered.promise;
    const before = [...disk.snapshot().keys()].sort();
    expect(disk.snapshot().has(`${tomb}/vault.json`)).toBe(false);
    lockTomb(tomb);
    unlockTomb(tomb, vaultKey);
    release.release();
    expect(await deleting).toBeInstanceOf(Error);
    expect([...disk.snapshot().keys()].sort()).toEqual(before);
    expect(vfsSeams.readRaw(tombFileKey(tomb, BODY_PATH))).toBe(
      JSON.stringify(blob),
    );
  } finally {
    release.release();
    lockTomb(tomb);
    restore();
  }
});

it("keeps a competing writer's newer body and documents", async () => {
  const disk = makeMemorySecretFiles();
  const restore = await installFileBackedVfs(disk);
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  const body = {
    ...emptyBody(),
    rev: 1,
    items: [createItem("note", "original")],
  };
  const binding = vaultSealBinding(tomb, BODY_PATH);
  unlockTomb(tomb, vaultKey);
  try {
    await writeSealedFile(
      tomb,
      BODY_PATH,
      await sealJson(vaultKey, body, binding),
    );
    const rival = createFileBackedVfs(disk);
    await rival.hydrate();
    await rival.seams.openBody(tomb, vaultKey);
    const newer = {
      ...body,
      rev: 2,
      items: [...body.items, createItem("note", "newer")],
    };
    await rival.seams.writeRaw(
      tombFileKey(tomb, BODY_PATH),
      JSON.stringify(await sealJson(vaultKey, newer, binding)),
      vaultKey,
    );
    const before = disk.snapshot();
    await expect(deleteFile(tomb, BODY_PATH)).rejects.toMatchObject({
      _tag: "SecretFsConflict",
    });
    const after = disk.snapshot();
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, bytes] of before) expect(after.get(path)).toEqual(bytes);
  } finally {
    lockTomb(tomb);
    restore();
  }
});
