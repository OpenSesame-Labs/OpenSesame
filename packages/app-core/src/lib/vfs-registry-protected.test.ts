import { overlapCast } from "@opensesame/os-domain";
import { afterEach, expect, it } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";
import { makeOpfs } from "./duress/wipe/fake-opfs.test-support.js";
import {
  kvFileName,
  kvFlush,
  kvForgetAll,
  kvGet,
  kvSet,
  kvSetDurable,
} from "./kv.js";
import {
  HEADER_PATH,
  TOMBS_REGISTRY_KEY,
  registerPersistedTomb,
  tombFileKey,
} from "./vfs.js";

const tomb = "guest_43be154c-4934-4d7f-ab3b-2216e834132c";
const header = tombFileKey(tomb, HEADER_PATH);
afterEach(async () => {
  await kvFlush();
  kvForgetAll();
  forgetAtRestKeyForTest();
  configureHost(createTestHost());
});

it("never reserves a guest tomb over a physical protected header missing from the registry", async () => {
  kvForgetAll();
  kvSet(header, "protected header fixture");
  await expect(
    registerPersistedTomb(tomb, () => {}, undefined, true, "reservation"),
  ).rejects.toThrow(/already exists/i);
  expect(kvGet(header)).toBe("protected header fixture");
  expect(kvGet(TOMBS_REGISTRY_KEY)).toBeNull();
});

it("refreshes a protected physical header missing from this tab's cache", async () => {
  const root = makeOpfs();
  forgetAtRestKeyForTest();
  configureHost(
    createTestHost({
      locks: webLocksDouble(),
      originFiles: async () => overlapCast(root),
    }),
  );
  await kvSetDurable(header, "protected header fixture");
  const physicalHeader = root.files.get(kvFileName(header));
  expect(physicalHeader).toBeDefined();
  kvForgetAll();
  expect(kvGet(header)).toBeNull();

  await expect(
    registerPersistedTomb(tomb, () => {}, undefined, true, "reservation"),
  ).rejects.toThrow(/already exists/i);
  expect(kvGet(header)).toBe("protected header fixture");
  expect(root.files.get(kvFileName(header))).toBe(physicalHeader);
  expect(kvGet(TOMBS_REGISTRY_KEY)).toBeNull();
});
