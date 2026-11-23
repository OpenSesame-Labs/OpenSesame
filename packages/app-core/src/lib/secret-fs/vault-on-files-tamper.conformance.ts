import { expect, it } from "vitest";
/**
 * A vault directory that has been tampered with (ADR 0182): a secret's file
 * deleted, put back at an older revision, swapped for another's, renamed by
 * hand or carried in from another vault, and a stray file nobody listed. The
 * vault must refuse each, or ignore it, and never open it.
 */
import { VaultCorruptError } from "../vault/store.js";
import type { FilesHarness } from "./files.conformance.js";
import {
  type InProcess,
  PASSWORD,
  run,
  secret,
  startProcess,
  versionedPath,
} from "./vault-on-files.support.js";

export function tamperCases(
  inProcess: InProcess,
  make: () => Promise<FilesHarness>,
): void {
  it("refuses to open a vault whose secret file has gone", () =>
    inProcess(async (files, restart, newStore) => {
      const store = newStore();
      await store.create(PASSWORD);
      await store.saveItems([secret("a"), secret("b")]);
      await run(
        files.remove(
          await versionedPath(files, "personal/secrets/a.secret.json"),
        ),
      );
      await expect(restart()).rejects.toBeInstanceOf(VaultCorruptError);
    }));

  it("refuses a secret file put back to an older revision", () =>
    inProcess(async (files, restart, newStore) => {
      const store = newStore();
      await store.create(PASSWORD);
      const item = secret("a", "v1");
      await store.saveItem(item);
      const oldPath = await versionedPath(
        files,
        "personal/secrets/a.secret.json",
      );
      const old = (await run(files.read(oldPath))).bytes;
      await store.saveItem({ ...item, value: "v2" });
      const [current] = await run(files.list("personal/secrets"));
      if (!current) throw new Error("missing current secret document");
      await run(files.write(current, old));
      await expect(restart()).rejects.toBeInstanceOf(VaultCorruptError);
    }));

  it("refuses two secrets' files swapped, and a file renamed by hand", () =>
    inProcess(async (files, restart, newStore) => {
      const store = newStore();
      await store.create(PASSWORD);
      await store.saveItems([secret("a", "1"), secret("b", "2")]);
      const aPath = await versionedPath(
        files,
        "personal/secrets/a.secret.json",
      );
      const bPath = await versionedPath(
        files,
        "personal/secrets/b.secret.json",
      );
      const a = (await run(files.read(aPath))).bytes;
      const b = (await run(files.read(bPath))).bytes;
      await run(files.write(aPath, b));
      await run(files.write(bPath, a));
      await expect(restart()).rejects.toBeInstanceOf(VaultCorruptError);
      await run(files.write(aPath, a));
      await run(files.write(bPath, b));
      await run(files.write("personal/secrets/moved.secret.json", a));
      await run(files.remove(aPath));
      await expect(restart()).rejects.toBeInstanceOf(VaultCorruptError);
    }));

  it("ignores a file nobody listed, rather than trusting it", () =>
    inProcess(async (files, restart, newStore) => {
      const store = newStore();
      await store.create(PASSWORD);
      await store.saveItem(secret("a"));
      const a = (
        await run(
          files.read(
            await versionedPath(files, "personal/secrets/a.secret.json"),
          ),
        )
      ).bytes;
      await run(files.write("personal/secrets/stray.secret.json", a));
      const reopened = await restart();
      expect(reopened.getSnapshot().items).toHaveLength(1);
    }));

  foreignVaultTamperCase(inProcess, make);
}

function foreignVaultTamperCase(
  inProcess: InProcess,
  make: () => Promise<FilesHarness>,
): void {
  it("refuses a secret file from another vault", async () => {
    const foreign = await make();
    const foreignProcess = await startProcess(foreign.files);
    let theirs: Uint8Array;
    try {
      const other = foreignProcess.newStore();
      await other.create(PASSWORD);
      await other.saveItem(secret("a", "theirs"));
      theirs = (
        await run(
          foreign.files.read(
            await versionedPath(
              foreign.files,
              "personal/secrets/a.secret.json",
            ),
          ),
        )
      ).bytes;
    } finally {
      foreignProcess.stop();
      await foreign.cleanup?.();
    }
    await inProcess(async (files, restart, newStore) => {
      const store = newStore();
      await store.create(PASSWORD);
      await store.saveItem(secret("a", "mine"));
      await run(
        files.write(
          await versionedPath(files, "personal/secrets/a.secret.json"),
          theirs,
        ),
      );
      await expect(restart()).rejects.toBeInstanceOf(VaultCorruptError);
    });
  });
}
