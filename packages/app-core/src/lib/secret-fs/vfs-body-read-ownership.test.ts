import {
  createItem,
  emptyBody,
  mintVaultKey,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { loadVaultBody } from "../vault/store-body.js";
import { deferred } from "../vault/store-unlock-races.fixture.js";
import {
  BODY_PATH,
  lockTomb,
  tombFileKey,
  unlockTomb,
  vfsSeams,
  writeSealedFile,
} from "../vfs.js";
import { SecretFsUnavailable } from "./errors.js";
import type { SecretFiles } from "./files.js";
import { installFileBackedVfs } from "./install.js";
import { makeMemorySecretFiles } from "./memory.js";

const tomb = "body-read-owner";

it("does not publish a body assembled for a retired unlock", async () => {
  const entered = deferred();
  const release = deferred();
  const disk = makeMemorySecretFiles();
  let block = false;
  const files: SecretFiles = {
    ...disk,
    read(path) {
      if (!block || path !== `${tomb}/vault.json`) return disk.read(path);
      return Effect.promise(async () => {
        entered.release();
        await release.promise;
      }).pipe(Effect.flatMap(() => disk.read(path)));
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
  const before = vfsSeams.readRaw(tombFileKey(tomb, BODY_PATH));
  block = true;
  const reading = loadVaultBody(tomb, vaultKey, null, () => {}).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    lockTomb(tomb);
    unlockTomb(tomb, vaultKey);
    block = false;
    release.release();
    expect(await reading).toBeInstanceOf(Error);
    expect(vfsSeams.readRaw(tombFileKey(tomb, BODY_PATH))).toBe(before);
    expect((await loadVaultBody(tomb, vaultKey, null)).items).toHaveLength(1);
  } finally {
    release.release();
    lockTomb(tomb);
    restore();
  }
});

it("does not retain an old mirror when the physical body is gone", async () => {
  const disk = makeMemorySecretFiles();
  const restore = await installFileBackedVfs(disk);
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  const body = { ...emptyBody(), items: [createItem("note", "fixture")] };
  const blob = await sealJson(
    vaultKey,
    body,
    vaultSealBinding(tomb, BODY_PATH),
  );
  unlockTomb(tomb, vaultKey);
  try {
    await writeSealedFile(tomb, BODY_PATH, blob);
    await Effect.runPromise(disk.remove(`${tomb}/vault.json`));
    expect((await loadVaultBody(tomb, vaultKey, null)).items).toHaveLength(0);
    expect(vfsSeams.readRaw(tombFileKey(tomb, BODY_PATH))).toBeNull();
  } finally {
    lockTomb(tomb);
    restore();
  }
});

it("honors cancellation before a vault owner is installed", async () => {
  const entered = deferred();
  const release = deferred();
  const disk = makeMemorySecretFiles();
  let block = false;
  const files: SecretFiles = {
    ...disk,
    read(path) {
      if (!block || path !== `${tomb}/vault.json`) return disk.read(path);
      return Effect.promise(async () => {
        entered.release();
        await release.promise;
      }).pipe(Effect.flatMap(() => disk.read(path)));
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
  lockTomb(tomb);
  const before = vfsSeams.readRaw(tombFileKey(tomb, BODY_PATH));
  let live = true;
  block = true;
  const reading = loadVaultBody(tomb, vaultKey, null, () => {
    if (!live) throw new Error("Original unlock ended");
  }).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    live = false;
    release.release();
    expect(await reading).toBeInstanceOf(Error);
    expect(vfsSeams.readRaw(tombFileKey(tomb, BODY_PATH))).toBe(before);
  } finally {
    release.release();
    lockTomb(tomb);
    restore();
  }
});

it("rejects a pre-unlock read if an unlock starts and ends while it waits", async () => {
  const entered = deferred();
  const release = deferred();
  const disk = makeMemorySecretFiles();
  let block = false;
  const files: SecretFiles = {
    ...disk,
    read(path) {
      if (!block || path !== `${tomb}/vault.json`) return disk.read(path);
      return Effect.promise(async () => {
        entered.release();
        await release.promise;
      }).pipe(Effect.flatMap(() => disk.read(path)));
    },
  };
  const restore = await installFileBackedVfs(files);
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  const blob = await sealJson(
    vaultKey,
    { ...emptyBody(), items: [createItem("note", "fixture")] },
    vaultSealBinding(tomb, BODY_PATH),
  );
  unlockTomb(tomb, vaultKey);
  await writeSealedFile(tomb, BODY_PATH, blob);
  lockTomb(tomb);
  block = true;
  const reading = loadVaultBody(tomb, vaultKey, null).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    unlockTomb(tomb, vaultKey);
    lockTomb(tomb);
    release.release();
    expect(await reading).toBeInstanceOf(Error);
  } finally {
    release.release();
    lockTomb(tomb);
    restore();
  }
});

it("does not cancel a pre-unlock read when a different tomb changes", async () => {
  const entered = deferred();
  const release = deferred();
  const disk = makeMemorySecretFiles();
  let block = false;
  const files: SecretFiles = {
    ...disk,
    read(path) {
      if (!block || path !== `${tomb}/vault.json`) return disk.read(path);
      return Effect.promise(async () => {
        entered.release();
        await release.promise;
      }).pipe(Effect.flatMap(() => disk.read(path)));
    },
  };
  const restore = await installFileBackedVfs(files);
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  const blob = await sealJson(
    vaultKey,
    { ...emptyBody(), items: [createItem("note", "fixture")] },
    vaultSealBinding(tomb, BODY_PATH),
  );
  unlockTomb(tomb, vaultKey);
  await writeSealedFile(tomb, BODY_PATH, blob);
  lockTomb(tomb);
  block = true;
  const reading = loadVaultBody(tomb, vaultKey, null);
  try {
    await entered.promise;
    unlockTomb("unrelated", vaultKey);
    lockTomb("unrelated");
    release.release();
    expect((await reading).items).toHaveLength(1);
  } finally {
    release.release();
    lockTomb(tomb);
    lockTomb("unrelated");
    restore();
  }
});

it("uses the physical manifest rather than a newer cached projection", async () => {
  const disk = makeMemorySecretFiles();
  const restore = await installFileBackedVfs(disk);
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  const body = {
    ...emptyBody(),
    rev: 1,
    items: [createItem("note", "fixture")],
  };
  const seal = (value: typeof body) =>
    sealJson(vaultKey, value, vaultSealBinding(tomb, BODY_PATH));
  unlockTomb(tomb, vaultKey);
  try {
    await writeSealedFile(tomb, BODY_PATH, await seal(body));
    const earlier = disk.snapshot();
    await writeSealedFile(tomb, BODY_PATH, await seal({ ...body, rev: 2 }));
    for (const path of await Effect.runPromise(disk.list("")))
      await Effect.runPromise(disk.remove(path));
    for (const [path, bytes] of earlier)
      await Effect.runPromise(disk.write(path, bytes));
    expect((await loadVaultBody(tomb, vaultKey, null)).rev).toBe(1);
  } finally {
    lockTomb(tomb);
    restore();
  }
});

it("does not treat an unreadable legacy body as absent", async () => {
  const disk = makeMemorySecretFiles();
  let unavailable = false;
  const files: SecretFiles = {
    ...disk,
    read(path) {
      return unavailable && path === `${tomb}/body.json`
        ? Effect.fail(new SecretFsUnavailable({ path, reason: "down" }))
        : disk.read(path);
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
  try {
    await writeSealedFile(tomb, BODY_PATH, blob);
    const before = vfsSeams.readRaw(tombFileKey(tomb, BODY_PATH));
    unavailable = true;
    await expect(loadVaultBody(tomb, vaultKey, null)).rejects.toMatchObject({
      _tag: "SecretFsUnavailable",
    });
    expect(vfsSeams.readRaw(tombFileKey(tomb, BODY_PATH))).toBe(before);
  } finally {
    lockTomb(tomb);
    restore();
  }
});
