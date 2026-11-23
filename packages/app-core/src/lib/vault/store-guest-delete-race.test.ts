import { expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import {
  deleteFile,
  readFile,
  tombFileKey,
  vfsFlush,
  vfsSeams,
  writeFile,
} from "../vfs.js";
import { newStore } from "./store-ops.fixture.js";
import {
  deferred,
  installUnlockRacesFixture,
} from "./store-unlock-races.fixture.js";

installUnlockRacesFixture();

it("retains the guest lease until an interrupted physical deletion settles", async () => {
  configureHost(createTestHost({ locks: webLocksDouble() }));
  const first = newStore();
  const second = newStore();
  await first.createGuest();
  const tomb = first.activeTomb();
  await first.enrollPin("48291037");
  const path = "config/credential";
  await writeFile(tomb, path, new TextEncoder().encode("old"));
  const started = deferred();
  const gate = deferred();
  const remove = vfsSeams.deleteRawGuarded;
  if (!remove) throw new Error("Missing guarded delete");
  vi.spyOn(vfsSeams, "deleteRawGuarded").mockImplementation(
    async (key, check) => {
      if (key === tombFileKey(tomb, path)) {
        started.release();
        await gate.promise;
      }
      await remove(key, check);
    },
  );
  const deletion = deleteFile(tomb, path);
  const interrupted = expect(deletion).rejects.toThrow();
  try {
    await started.promise;
    first.lock();
    second.prepareGuestUnlock(tomb);
    await expect(second.unlockWithPin("48291037")).rejects.toThrow();
  } finally {
    gate.release();
  }
  await interrupted;
  await vfsFlush();
  second.prepareGuestUnlock(tomb);
  await second.unlockWithPin("48291037");
  await writeFile(tomb, path, new TextEncoder().encode("new"));
  expect(new TextDecoder().decode(await readFile(tomb, path))).toBe("new");
  second.lock();
});
