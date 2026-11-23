import { afterEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { atRestReady, forgetAtRestKeyForTest } from "./at-rest/key.js";
import {
  kvDeleteDurable,
  kvForgetAll,
  kvGet,
  kvRefresh,
  kvSetDurable,
} from "./kv.js";

function emptyOpfsRoot(touched: string[] = []) {
  return {
    async getFileHandle() {
      throw new DOMException("not found", "NotFoundError");
    },
    async removeEntry(name: string) {
      touched.push(name);
      throw new DOMException("not found", "NotFoundError");
    },
  };
}

afterEach(() => {
  forgetAtRestKeyForTest();
  kvForgetAll();
  configureHost(createTestHost());
  vi.unstubAllGlobals();
});

describe("kvRefresh with an ephemeral at-rest key", () => {
  it("keeps a session-only record that never reached a file", async () => {
    // The browser refused the at-rest key, so the document runs session-only.
    forgetAtRestKeyForTest();
    configureHost(
      createTestHost({
        atRestKeys: { load: () => Promise.reject(new Error("blocked")) },
      }),
    );
    expect((await atRestReady()).durable).toBe(false);
    vi.stubGlobal("navigator", {
      storage: { getDirectory: () => Promise.resolve(emptyOpfsRoot()) },
    });
    await kvSetDurable("tomb.default.index", "session-only index");
    await kvRefresh("tomb.default.index", 1024);
    expect(kvGet("tomb.default.index")).toBe("session-only index");
  });

  it("forgets a session-only record under a guarded delete without touching a file", async () => {
    forgetAtRestKeyForTest();
    configureHost(
      createTestHost({
        atRestKeys: { load: () => Promise.reject(new Error("blocked")) },
      }),
    );
    expect((await atRestReady()).durable).toBe(false);
    const touched: string[] = [];
    vi.stubGlobal("navigator", {
      storage: { getDirectory: () => Promise.resolve(emptyOpfsRoot(touched)) },
    });
    await kvSetDurable("tomb.default.config", "session-only config");
    let live = true;
    await expect(
      kvDeleteDurable("tomb.default.config", () => {
        if (!live) throw new Error("Original owner ended");
      }),
    ).resolves.toBeUndefined();
    expect(kvGet("tomb.default.config")).toBeNull();
    expect(touched).toEqual([]);
    await kvSetDurable("tomb.default.config", "kept");
    live = false;
    await expect(
      kvDeleteDurable("tomb.default.config", () => {
        if (!live) throw new Error("Original owner ended");
      }),
    ).rejects.toThrow("Original owner ended");
    expect(kvGet("tomb.default.config")).toBe("kept");
  });
});
