import { overlapCast } from "@opensesame/os-domain";
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { makeOpfs } from "../duress/wipe/fake-opfs.test-support.js";
import { kvFileName, kvForgetAll } from "../kv.js";
import {
  readVercelConnectAuth,
  writeVercelConnectAuth,
} from "../vercel-connect-session.js";
import {
  INDEX_PATH,
  PERSONAL_TOMB,
  SEAL_BOUND_MARKER_PATH,
  listDir,
  lockAllTombs,
  readFile,
  readPlaintextFile,
  tombFileKey,
  unlockTomb,
  vfsFlush,
  writeFile,
} from "../vfs.js";
import { rebindTombSeals, rekeyTomb } from "./seal-rebind.js";

let root: ReturnType<typeof makeOpfs>;
beforeEach(() => {
  root = makeOpfs();
  configureHost(
    createTestHost({
      locks: webLocksDouble(),
      originFiles: async () => overlapCast(root),
    }),
  );
  kvForgetAll();
  lockAllTombs();
});
afterEach(async () => {
  await vfsFlush();
  lockAllTombs();
  kvForgetAll();
  vi.restoreAllMocks();
  configureHost(createTestHost());
});

describe("seal rebind keeps the sealed index across a reload", () => {
  it("loads a file written before the first unlock after sealing", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    await writeFile(
      PERSONAL_TOMB,
      "config/kept",
      new TextEncoder().encode("x"),
    );
    kvForgetAll();
    await rebindTombSeals(PERSONAL_TOMB, vaultKey);
    expect(await listDir(PERSONAL_TOMB, "config")).toEqual(["config/kept"]);
  });

  it("loads indexed credentials on a cold open after binding is complete", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    await writeVercelConnectAuth(PERSONAL_TOMB, { token: "prior-token" });
    await rebindTombSeals(PERSONAL_TOMB, vaultKey);
    kvForgetAll();
    await rebindTombSeals(PERSONAL_TOMB, vaultKey);
    expect(await readVercelConnectAuth(PERSONAL_TOMB)).toEqual({
      token: "prior-token",
    });
  });

  it("does not overwrite the index when its physical read fails", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    await writeFile(
      PERSONAL_TOMB,
      "config/kept",
      new TextEncoder().encode("x"),
    );
    const index = kvFileName(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
    const before = root.files.get(index);
    kvForgetAll();
    const get = root.getFileHandle.bind(root);
    let fail = true;
    vi.spyOn(root, "getFileHandle").mockImplementation(async (name, opts) => {
      if (name === index && fail) {
        fail = false;
        throw new Error("index unavailable");
      }
      return get(name, opts);
    });
    await expect(rebindTombSeals(PERSONAL_TOMB, vaultKey)).rejects.toThrow(
      "index unavailable",
    );
    expect(root.files.get(index)).toBe(before);
    await rebindTombSeals(PERSONAL_TOMB, vaultKey);
    expect(await listDir(PERSONAL_TOMB, "config")).toEqual(["config/kept"]);
  });

  it("keeps unrelated files available when one indexed config is corrupt", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    await writeFile(
      PERSONAL_TOMB,
      "config/good",
      new TextEncoder().encode("kept"),
    );
    await writeFile(
      PERSONAL_TOMB,
      "config/bad",
      new TextEncoder().encode("broken"),
    );
    await rebindTombSeals(PERSONAL_TOMB, vaultKey);
    root.files.set(
      kvFileName(tombFileKey(PERSONAL_TOMB, "config/bad")),
      "corrupt",
    );
    kvForgetAll();
    await expect(rebindTombSeals(PERSONAL_TOMB, vaultKey)).resolves.toBe(false);
    expect(
      new TextDecoder().decode(await readFile(PERSONAL_TOMB, "config/good")),
    ).toBe("kept");
    await expect(readFile(PERSONAL_TOMB, "config/bad")).rejects.toThrow();
  });

  it("unlocks past a corrupt config on a tomb that is not yet bound", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    await writeFile(
      PERSONAL_TOMB,
      "config/good",
      new TextEncoder().encode("kept"),
    );
    await writeFile(
      PERSONAL_TOMB,
      "config/bad",
      new TextEncoder().encode("broken"),
    );
    await vfsFlush();
    root.files.set(
      kvFileName(tombFileKey(PERSONAL_TOMB, "config/bad")),
      "corrupt",
    );
    kvForgetAll();
    await expect(rebindTombSeals(PERSONAL_TOMB, vaultKey)).resolves.toBe(false);
    expect(readPlaintextFile(PERSONAL_TOMB, SEAL_BOUND_MARKER_PATH)).toBeNull();
    expect(await listDir(PERSONAL_TOMB, "config")).toEqual([
      "config/bad",
      "config/good",
    ]);
    expect(
      new TextDecoder().decode(await readFile(PERSONAL_TOMB, "config/good")),
    ).toBe("kept");
  });

  it("stops a key rotation when a file on an unbound tomb cannot be loaded", async () => {
    const old = await mintVaultKey();
    const next = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, old.vaultKey);
    await writeFile(
      PERSONAL_TOMB,
      "config/good",
      new TextEncoder().encode("kept"),
    );
    await writeFile(
      PERSONAL_TOMB,
      "config/bad",
      new TextEncoder().encode("broken"),
    );
    await vfsFlush();
    const bad = kvFileName(tombFileKey(PERSONAL_TOMB, "config/bad"));
    const stranded = root.files.get(bad);
    root.files.set(bad, "unreadable for now");
    kvForgetAll();
    await expect(
      rekeyTomb(PERSONAL_TOMB, old.vaultKey, next.rawVaultKey),
    ).rejects.toThrow("not rotated");
    // The tomb still answers to the old key once the read recovers.
    if (stranded !== undefined) root.files.set(bad, stranded);
    kvForgetAll();
    lockAllTombs();
    unlockTomb(PERSONAL_TOMB, old.vaultKey);
    await expect(rebindTombSeals(PERSONAL_TOMB, old.vaultKey)).resolves.toBe(
      true,
    );
    expect(
      new TextDecoder().decode(await readFile(PERSONAL_TOMB, "config/bad")),
    ).toBe("broken");
  });
});
