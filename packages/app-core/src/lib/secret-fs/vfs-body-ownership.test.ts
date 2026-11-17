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
  lockTomb,
  tombFileKey,
  unlockTomb,
  vfsSeams,
  writeSealedFile,
} from "../vfs.js";
import type { SecretFiles } from "./files.js";
import { installFileBackedVfs } from "./install.js";
import { makeMemorySecretFiles } from "./memory.js";

it("does not start a queued body projection after its original owner locks", async () => {
  const entered = deferred();
  const release = deferred();
  const queued = deferred();
  const disk = makeMemorySecretFiles();
  const files: SecretFiles = {
    ...disk,
    write(path, bytes, options) {
      if (path !== "t/header.json") return disk.write(path, bytes, options);
      return Effect.promise(async () => {
        entered.release();
        await release.promise;
        return Effect.runPromise(disk.write(path, bytes, options));
      });
    },
  };
  const restore = await installFileBackedVfs(files);
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  const body = {
    ...emptyBody(),
    items: [createItem("note", "owner fixture")],
  };
  const blob = await sealJson(vaultKey, body, vaultSealBinding("t", BODY_PATH));
  const owned = vfsSeams.writeOwnedBody;
  if (!owned) throw new Error("Missing guarded body fixture");
  vfsSeams.writeOwnedBody = (key, value, check, secret) => {
    if (key === tombFileKey("t", BODY_PATH)) queued.release();
    return owned(key, value, check, secret);
  };
  unlockTomb("t", vaultKey);
  const live = true;
  const blocker = vfsSeams.writeRaw("tomb/t/header", "fixture");
  await entered.promise;
  const outcome = writeSealedFile("t", BODY_PATH, blob, () => {
    if (!live) throw new Error("Original owner ended");
  }).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await queued.promise;
    lockTomb("t");
    // Reusing the same CryptoKey must not revive the retired unlock.
    unlockTomb("t", vaultKey);
    release.release();
    await blocker;
    expect(await outcome).toBeInstanceOf(Error);
    expect([...disk.snapshot().keys()]).toEqual(["t/header.json"]);
    expect(vfsSeams.readRaw(tombFileKey("t", BODY_PATH))).toBeNull();
    await writeSealedFile("t", BODY_PATH, blob, () => {
      if (!live) throw new Error("Original owner ended");
    });
    expect(disk.snapshot().has("t/vault.json")).toBe(true);
    expect(vfsSeams.readRaw(tombFileKey("t", BODY_PATH))).toBe(
      JSON.stringify(blob),
    );
  } finally {
    release.release();
    lockTomb("t");
    restore();
  }
});

it.each(["staging", "secret", "manifest"] as const)(
  "does not commit a pending %s write after the owner locks",
  async (boundary) => {
    const entered = deferred();
    const release = deferred();
    const disk = makeMemorySecretFiles();
    const guarded = disk.writeGuarded?.bind(disk);
    if (!guarded) throw new Error("Missing guarded write fixture");
    const files: SecretFiles = {
      ...disk,
      writeGuarded(path, bytes, check, options) {
        const targeted =
          boundary === "staging"
            ? path.includes("/staging/")
            : boundary === "secret"
              ? path.includes("/secrets/")
              : path === "t/vault.json";
        if (!targeted) return guarded(path, bytes, check, options);
        return Effect.promise(async () => {
          entered.release();
          await release.promise;
        }).pipe(Effect.flatMap(() => guarded(path, bytes, check, options)));
      },
    };
    const restore = await installFileBackedVfs(files);
    const { vaultKey, rawVaultKey } = await mintVaultKey();
    rawVaultKey.fill(0);
    const body = { ...emptyBody(), items: [createItem("note", "fixture")] };
    const blob = await sealJson(
      vaultKey,
      body,
      vaultSealBinding("t", BODY_PATH),
    );
    unlockTomb("t", vaultKey);
    let live = true;
    const outcome = writeSealedFile("t", BODY_PATH, blob, () => {
      if (!live) throw new Error("Original owner ended");
    }).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      const before = [...disk.snapshot().keys()].sort();
      live = false;
      lockTomb("t");
      release.release();
      expect(await outcome).toBeInstanceOf(Error);
      expect([...disk.snapshot().keys()].sort()).toEqual(before);
      expect(disk.snapshot().has("t/vault.json")).toBe(false);
      expect(vfsSeams.readRaw(tombFileKey("t", BODY_PATH))).toBeNull();
    } finally {
      release.release();
      lockTomb("t");
      restore();
    }
  },
);

it("does not remove an old secret after its owner locks during cleanup", async () => {
  const entered = deferred();
  const release = deferred();
  const disk = makeMemorySecretFiles();
  const guarded = disk.removeGuarded?.bind(disk);
  if (!guarded) throw new Error("Missing guarded removal fixture");
  let block = false;
  const files: SecretFiles = {
    ...disk,
    removeGuarded(path, check, options) {
      if (!block || !path.includes("/secrets/"))
        return guarded(path, check, options);
      return Effect.promise(async () => {
        entered.release();
        await release.promise;
      }).pipe(Effect.flatMap(() => guarded(path, check, options)));
    },
  };
  const restore = await installFileBackedVfs(files);
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  const binding = vaultSealBinding("t", BODY_PATH);
  const initial = { ...emptyBody(), items: [createItem("note", "fixture")] };
  const blob = await sealJson(vaultKey, initial, binding);
  const updated = await sealJson(
    vaultKey,
    { ...initial, items: [], rev: 1 },
    binding,
  );
  unlockTomb("t", vaultKey);
  let live = true;
  const check = () => {
    if (!live) throw new Error("Original owner ended");
  };
  try {
    await writeSealedFile("t", BODY_PATH, blob, check);
    block = true;
    const outcome = writeSealedFile("t", BODY_PATH, updated, check).then(
      () => null,
      (error: unknown) => error,
    );
    await entered.promise;
    const before = [...disk.snapshot().keys()].sort();
    live = false;
    lockTomb("t");
    release.release();
    expect(await outcome).toBeInstanceOf(Error);
    expect([...disk.snapshot().keys()].sort()).toEqual(before);
    expect(vfsSeams.readRaw(tombFileKey("t", BODY_PATH))).toBe(
      JSON.stringify(blob),
    );
  } finally {
    release.release();
    lockTomb("t");
    restore();
  }
});

it("refuses a body update without guarded physical removal and exposes no IAM grant", async () => {
  const disk = makeMemorySecretFiles();
  const { removeGuarded: _missing, ...unsupported } = disk;
  const previous = vfsSeams.writeOwnedBody;
  const restore = await installFileBackedVfs(unsupported);
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  const blob = await sealJson(
    vaultKey,
    emptyBody(),
    vaultSealBinding("t", BODY_PATH),
  );
  unlockTomb("t", vaultKey);
  try {
    expect(vfsSeams.writeOwnedBody).toBeUndefined();
    expect(vfsSeams.writeRawGuarded).toBeUndefined();
    expect(vfsSeams.refreshRaw).toBeUndefined();
    await expect(writeSealedFile("t", BODY_PATH, blob)).rejects.toThrow(
      /cannot commit an original-owner/,
    );
    expect(disk.snapshot().size).toBe(0);
  } finally {
    lockTomb("t");
    restore();
  }
  expect(vfsSeams.writeOwnedBody).toBe(previous);
});

it("restricts the guarded body seam to a keyed body", async () => {
  const disk = makeMemorySecretFiles();
  const restore = await installFileBackedVfs(disk);
  try {
    const write = vfsSeams.writeOwnedBody;
    if (!write) throw new Error("Missing guarded body writer");
    await expect(write("tomb/t/header", "{}", () => {})).rejects.toThrow(
      /unlocked vault body/,
    );
    await expect(
      write(tombFileKey("t", BODY_PATH), "{}", () => {}),
    ).rejects.toThrow(/unlocked vault body/);
    expect(disk.snapshot().size).toBe(0);
  } finally {
    restore();
  }
});

it("retires a body write if its guarded transport changes while pending", async () => {
  const entered = deferred();
  const release = deferred();
  const disk = makeMemorySecretFiles();
  const guarded = disk.writeGuarded?.bind(disk);
  if (!guarded) throw new Error("Missing guarded backend fixture");
  const files: SecretFiles = {
    ...disk,
    writeGuarded(path, bytes, check, options) {
      return Effect.promise(async () => {
        entered.release();
        await release.promise;
      }).pipe(Effect.flatMap(() => guarded(path, bytes, check, options)));
    },
  };
  const restore = await installFileBackedVfs(files);
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  rawVaultKey.fill(0);
  const body = { ...emptyBody(), items: [createItem("note", "fixture")] };
  const blob = await sealJson(vaultKey, body, vaultSealBinding("t", BODY_PATH));
  unlockTomb("t", vaultKey);
  const outcome = writeSealedFile("t", BODY_PATH, blob, () => {}).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    const original = vfsSeams.writeOwnedBody;
    if (!original) throw new Error("Missing guarded body writer");
    vfsSeams.writeOwnedBody = (...args) => original(...args);
    release.release();
    expect(await outcome).toBeInstanceOf(Error);
    expect(disk.snapshot().size).toBe(0);
    expect(vfsSeams.readRaw(tombFileKey("t", BODY_PATH))).toBeNull();
  } finally {
    release.release();
    lockTomb("t");
    restore();
  }
});
