import { createItem } from "@opensesame/vault-core";
import { expect, it } from "vitest";
import { VaultStore } from "../vault/store.js";
import { vfsFlush, writeFile } from "../vfs.js";
import { installFileBackedVfs } from "./install.js";
import { makeMemorySecretFiles } from "./memory.js";

it("keeps guest files in memory and refuses unsupported promotion before writing files", async () => {
  const files = makeMemorySecretFiles();
  const restore = await installFileBackedVfs(files);
  const store = new VaultStore();
  try {
    await store.createGuest();
    const tomb = store.activeTomb();
    await store.saveItem(createItem("note", "Temporary guest"));
    await writeFile(
      tomb,
      "config/example",
      new TextEncoder().encode("private"),
    );
    expect(
      [...files.snapshot().keys()].some((key) => key.startsWith(`${tomb}/`)),
    ).toBe(false);
    await expect(store.enrollPin("48291037")).rejects.toThrow(
      /cannot protect a temporary guest/i,
    );
    expect(
      [...files.snapshot().keys()].some((key) => key.startsWith(`${tomb}/`)),
    ).toBe(false);
    store.lock();
    await vfsFlush();
    expect(
      [...files.snapshot().keys()].some((key) => key.startsWith(`${tomb}/`)),
    ).toBe(false);
  } finally {
    store.lock();
    restore();
  }
});
