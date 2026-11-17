import { afterEach, describe, expect, it, vi } from "vitest";

const ENTRY_A = "https://example.test/OpenSesame/assets/pages-AbCd1234.js";
const ENTRY_B = "https://example.test/OpenSesame/assets/pages-EfGh5678.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("stale asset reload guard", () => {
  it("keeps a retry across the same build and permits a retry on a new build", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const first = (await import("./stale-asset-reload.js")).staleAssetReload;
    first.beginBuild(ENTRY_A);
    expect(first.already()).toBe(false);
    expect(first.mark()).toBe(true);

    vi.resetModules();
    const same = (await import("./stale-asset-reload.js")).staleAssetReload;
    same.beginBuild(ENTRY_A);
    expect(same.already()).toBe(true);

    vi.resetModules();
    const updated = (await import("./stale-asset-reload.js")).staleAssetReload;
    updated.beginBuild(ENTRY_B);
    expect(updated.already()).toBe(false);
    expect(updated.mark()).toBe(true);
  });

  it("does not claim a reload can be guarded when tab storage is unavailable", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage unavailable");
      },
      removeItem: () => undefined,
    });
    const guard = (await import("./stale-asset-reload.js")).staleAssetReload;
    guard.beginBuild(ENTRY_A);
    expect(guard.mark()).toBe(false);
    expect(guard.already()).toBe(true);
  });
});
