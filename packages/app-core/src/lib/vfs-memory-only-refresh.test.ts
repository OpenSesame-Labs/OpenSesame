import { overlapCast } from "@opensesame/os-domain";
import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, expect, it } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { atRestSettled, forgetAtRestKeyForTest } from "./at-rest/key.js";
import { makeOpfs } from "./duress/wipe/fake-opfs.test-support.js";
import { kvForgetAll } from "./kv.js";
import { rebindTombSeals } from "./vault/seal-rebind.js";
import {
  listDir,
  lockAllTombs,
  readFile,
  unlockTomb,
  vfsFlush,
  writeFile,
} from "./vfs.js";

afterEach(async () => {
  await vfsFlush();
  lockAllTombs();
  kvForgetAll();
  forgetAtRestKeyForTest();
  configureHost(createTestHost());
});

it("keeps live memory-only files when OPFS exists but its device key is unavailable", async () => {
  const root = makeOpfs();
  forgetAtRestKeyForTest();
  configureHost(
    createTestHost({
      atRestKeys: undefined,
      originFiles: async () => overlapCast(root),
    }),
  );
  const { vaultKey } = await mintVaultKey();
  unlockTomb("personal", vaultKey);
  await writeFile(
    "personal",
    "config/demo",
    new TextEncoder().encode("memory"),
  );
  expect(atRestSettled()?.durable).toBe(false);
  expect(
    new TextDecoder().decode(await readFile("personal", "config/demo")),
  ).toBe("memory");
  await rebindTombSeals("personal", vaultKey);
  expect(await listDir("personal", "config")).toEqual(["config/demo"]);
  expect(
    new TextDecoder().decode(await readFile("personal", "config/demo")),
  ).toBe("memory");
});
