import {
  type VaultBody,
  createItem,
  emptyBody,
  mintVaultKey,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { BODY_PATH } from "../vfs.js";
import type { SecretFsError } from "./errors.js";
import { SecretFsUnavailable } from "./errors.js";
import type { SecretFiles } from "./files.js";
import { makeMemorySecretFiles } from "./memory.js";
import { createFileBackedVfs } from "./vfs-files.js";

const BODY_KEY = `tomb/t/${BODY_PATH}`;
const binding = vaultSealBinding("t", BODY_PATH);
const run = <A>(effect: Effect.Effect<A, SecretFsError>) =>
  Effect.runPromise(effect);

const bodyOf = (rev: number, ...names: string[]): VaultBody => ({
  ...emptyBody(),
  rev,
  items: names.map((name) => ({
    ...createItem("note", name),
    id: `id-${name}`,
  })),
});

async function opened(files: SecretFiles) {
  const vfs = createFileBackedVfs(files);
  await vfs.hydrate();
  return vfs;
}

async function seeded(files: SecretFiles) {
  const { vaultKey } = await mintVaultKey();
  const vfs = await opened(files);
  const value = JSON.stringify(
    await sealJson(vaultKey, bodyOf(1, "a", "b"), binding),
  );
  await vfs.seams.writeRaw(BODY_KEY, value, vaultKey);
  return { vfs, vaultKey };
}

/** Fail the first removal of a secret document, as an outage would. */
function failOneSecretRemoval(disk: ReturnType<typeof makeMemorySecretFiles>) {
  const state = { armed: false, failed: 0 };
  const failing = (path: string) => {
    if (!state.armed || !path.startsWith("t/secrets/")) return false;
    state.armed = false;
    state.failed += 1;
    return true;
  };
  const guarded = disk.removeGuarded?.bind(disk);
  const files: SecretFiles = {
    ...disk,
    remove: (path, options) =>
      failing(path)
        ? Effect.fail(new SecretFsUnavailable({ path, reason: "down" }))
        : disk.remove(path, options),
    ...(guarded && {
      removeGuarded: (path, check, options) =>
        failing(path)
          ? Effect.fail(new SecretFsUnavailable({ path, reason: "down" }))
          : guarded(path, check, options),
    }),
  };
  return { files, state };
}

describe("destroying a file-backed body", () => {
  it("removes a vault this adapter never opened, after a restart", async () => {
    const disk = makeMemorySecretFiles();
    await seeded(disk);
    expect(disk.snapshot().has("t/vault.json")).toBe(true);
    const restarted = await opened(disk);
    await restarted.seams.deleteRaw(BODY_KEY);
    expect(await run(disk.list("t"))).toEqual([]);
  });

  it("removes it through the owned deletion seam too", async () => {
    const disk = makeMemorySecretFiles();
    await seeded(disk);
    const restarted = await opened(disk);
    const remove = restarted.seams.deleteOwnedFile;
    if (!remove) throw new Error("Missing owned deletion fixture");
    await remove(BODY_KEY, () => {});
    expect(await run(disk.list("t"))).toEqual([]);
  });

  it("finishes on retry after a failure past the manifest removal", async () => {
    const disk = makeMemorySecretFiles();
    const { files, state } = failOneSecretRemoval(disk);
    const { vfs } = await seeded(files);
    state.armed = true;
    await expect(vfs.seams.deleteRaw(BODY_KEY)).rejects.toMatchObject({
      _tag: "SecretFsUnavailable",
    });
    expect(state.failed).toBe(1);
    expect(disk.snapshot().has("t/vault.json")).toBe(false);
    await vfs.seams.deleteRaw(BODY_KEY);
    expect(await run(disk.list("t"))).toEqual([]);
    expect(vfs.seams.readRaw(BODY_KEY)).toBeNull();
  });

  it("still refuses a competing writer's manifest on the retry", async () => {
    const disk = makeMemorySecretFiles();
    const { files, state } = failOneSecretRemoval(disk);
    const { vfs, vaultKey } = await seeded(files);
    state.armed = true;
    await expect(vfs.seams.deleteRaw(BODY_KEY)).rejects.toMatchObject({
      _tag: "SecretFsUnavailable",
    });
    const rival = await opened(disk);
    await rival.seams.writeRaw(
      BODY_KEY,
      JSON.stringify(await sealJson(vaultKey, bodyOf(2, "rival"), binding)),
      vaultKey,
    );
    const manifest = disk.snapshot().get("t/vault.json");
    expect(manifest).toBeDefined();
    await expect(vfs.seams.deleteRaw(BODY_KEY)).rejects.toMatchObject({
      _tag: "SecretFsConflict",
    });
    expect(disk.snapshot().get("t/vault.json")).toEqual(manifest);
  });
});
