import { expect, it } from "vitest";
import { deferred, withFixture } from "./kv.entry-lifecycle.test-support.js";
import { kvDeleteDurable, kvFileName, kvGet, kvSetDurable } from "./kv.js";

it("does not unlink a guarded file when its owner ends while storage opens", () =>
  withFixture(async (root) => {
    const key = "lifecycle/guarded-delete-owner";
    await kvSetDurable(key, "kept");
    const name = kvFileName(key);
    const sealed = root.files.get(name);
    expect(sealed).toBeTruthy();
    const opening = deferred();
    const release = deferred();
    root.hooks.root = async () => {
      opening.resolve();
      await release.promise;
    };
    let owned = true;
    const ended = new Error("owner ended");
    const removal = kvDeleteDurable(key, () => {
      if (!owned) throw ended;
    });
    const refused = expect(removal).rejects.toBe(ended);
    await opening.promise;
    // The vault locks while the storage root is still being acquired.
    owned = false;
    release.resolve();
    await refused;
    expect(root.files.get(name)).toBe(sealed);
    expect(root.events).not.toContain(`remove:${name}`);
    expect(kvGet(key)).toBe("kept");
  }));
