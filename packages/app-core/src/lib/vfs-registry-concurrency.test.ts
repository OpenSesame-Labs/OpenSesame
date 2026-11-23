/**
 * The tomb registry is shared by every tab. A tab's cached copy can be stale,
 * so changes refresh the physical record under the registry lock, and an
 * unreadable record is never replaced with a shorter one.
 */
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
  let physical = JSON.stringify({ v: 1, tombs: ["other-tab-vault"] });
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
  await registerTomb("this-tab-vault");
  expect(JSON.parse(physical).tombs).toEqual([
    "other-tab-vault",
    "this-tab-vault",
  ]);
  cached = JSON.stringify({ v: 1, tombs: ["this-tab-vault"] });
  await unregisterTomb("this-tab-vault");
  expect(JSON.parse(physical).tombs).toEqual(["other-tab-vault"]);
  expect(refresh).toHaveBeenCalledTimes(2);
});

it("refuses to overwrite a malformed or unreadable registry", async () => {
  const write = vi.fn();
  Object.assign(vfsSeams, {
    refreshRaw: vi.fn(async () => {}),
    readRaw: () => "{broken",
    writeRaw: write,
  });
  await expect(registerTomb("new-vault")).rejects.toThrow("vault registry");
  expect(write).not.toHaveBeenCalled();
  Object.assign(vfsSeams, {
    refreshRaw: vi.fn(async () => {
      throw new Error("disk offline");
    }),
    readRaw: () => JSON.stringify({ v: 1, tombs: ["new-vault", "kept"] }),
  });
  await expect(unregisterTomb("new-vault")).rejects.toThrow("disk offline");
  expect(write).not.toHaveBeenCalled();
});
