import { afterEach, expect, it, vi } from "vitest";
import {
  TOMBS_REGISTRY_KEY,
  registerTomb,
  unregisterTomb,
  vfsSeams,
} from "./vfs.js";

const original = { ...vfsSeams };
afterEach(() => Object.assign(vfsSeams, original));

it("refreshes the physical registry before adding or removing a tomb", async () => {
  let physical = JSON.stringify({ v: 1, tombs: ["guest-existing"] });
  let cached: string | null = JSON.stringify({ v: 1, tombs: [] });
  const refresh = vi.fn(async (key: string) => {
    expect(key).toBe(TOMBS_REGISTRY_KEY);
    cached = physical;
  });
  Object.assign(vfsSeams, {
    refreshRaw: refresh,
    readRaw: () => cached,
    writeRaw: async (_key: string, value: string) => {
      physical = value;
      cached = value;
    },
  });
  await registerTomb("guest-new");
  expect(JSON.parse(physical).tombs).toEqual(["guest-existing", "guest-new"]);
  cached = JSON.stringify({ v: 1, tombs: ["guest-new"] });
  await unregisterTomb("guest-new");
  expect(JSON.parse(physical).tombs).toEqual(["guest-existing"]);
  expect(refresh).toHaveBeenCalledTimes(2);
});

it("refuses to overwrite a malformed or unreadable registry", async () => {
  const write = vi.fn();
  Object.assign(vfsSeams, {
    refreshRaw: vi.fn(async () => {}),
    readRaw: () => "{broken",
    writeRaw: write,
  });
  await expect(registerTomb("guest-new")).rejects.toThrow("vault registry");
  expect(write).not.toHaveBeenCalled();
  vfsSeams.refreshRaw = vi.fn(async () => {
    throw new Error("disk offline");
  });
  await expect(unregisterTomb("guest-new")).rejects.toThrow("disk offline");
  expect(write).not.toHaveBeenCalled();
});
