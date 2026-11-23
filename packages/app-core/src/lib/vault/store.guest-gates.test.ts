import { createItem, createVault } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import { isLocalOnlyGuest } from "../guest-session-context.js";
import { isIsolatedGuestVaultId } from "../guest-vault-id.js";
import { kvDelete, kvGet, kvSet } from "../kv.js";
import { readGuestSessionPerson } from "../local-guest.js";
import { GUEST_TOMB, HEADER_PATH, PERSONAL_TOMB, tombFileKey } from "../vfs.js";
import { VaultStore } from "./store.js";

const HEADER_KEY = tombFileKey(PERSONAL_TOMB, HEADER_PATH);

beforeEach(() => {
  kvDelete(HEADER_KEY);
  kvDelete(tombFileKey(GUEST_TOMB, HEADER_PATH));
});

describe("isolated and protected guest vaults", () => {
  it("refuses to create a protected vault directly in an empty guest scope", async () => {
    const store = new VaultStore();
    store.prepareGuestUnlock();
    await expect(store.createWithPin("48291037")).rejects.toThrow(
      /start a guest session/i,
    );
    expect(store.isUnlocked()).toBe(false);
  });
  it("starts a separate guest beside a legacy protected vault", async () => {
    const { header } = await createVault("legacy guest password");
    const key = tombFileKey(GUEST_TOMB, HEADER_PATH);
    kvSet(key, JSON.stringify(header));
    const store = new VaultStore();
    await store.createGuest();
    expect(isIsolatedGuestVaultId(store.activeTomb())).toBe(true);
    expect(kvGet(key)).toBe(JSON.stringify(header));
    store.lock();
  });

  it("preserves a keyed guest and its actor while another guest uses the device", async () => {
    const store = new VaultStore();
    await store.createGuest();
    const protectedId = store.activeTomb();
    const actor = readGuestSessionPerson();
    await store.saveItem(createItem("note", "Protected guest item"));
    await store.enrollPin("48291037");
    await store.flushPendingWrites();
    store.lock();

    await store.createGuest();
    expect(store.activeTomb()).not.toBe(protectedId);
    expect(readGuestSessionPerson()?.id).not.toBe(actor?.id);
    await store.saveItem(createItem("note", "Another guest item"));
    store.lock();

    store.prepareGuestUnlock(protectedId);
    await store.unlockWithPin("48291037");
    expect(store.getSnapshot().items.map((item) => item.name)).toContain(
      "Protected guest item",
    );
    expect(store.getSnapshot().items.map((item) => item.name)).not.toContain(
      "Another guest item",
    );
    expect(readGuestSessionPerson()?.id).toBe(actor?.id);
    store.lock();
  });

  it("reopens a newly protected guest after rehydration", async () => {
    const { header } = await createVault("correct horse battery staple");
    kvSet(HEADER_KEY, JSON.stringify(header));
    const store = new VaultStore();
    await store.createGuest();
    const guest = store.activeTomb();
    await store.enrollPin("48291037");
    expect(kvGet(tombFileKey(guest, HEADER_PATH))).not.toBeNull();
    store.lock();

    const reopened = new VaultStore();
    reopened.rehydrate();
    const snap = reopened.getSnapshot();
    expect(snap.tomb).toBe(guest);
    expect(snap.status).toBe("locked");
    expect(snap.header?.unlocks?.pin).toBeTruthy();
    await reopened.unlockWithPin("48291037");
    expect(reopened.isUnlocked()).toBe(true);
    expect(kvGet(HEADER_KEY)).toBe(JSON.stringify(header));
    reopened.lock();
  });

  it("keeps the local-only restriction when a protected guest is reopened", async () => {
    const store = new VaultStore();
    await store.createGuest({ localOnly: true });
    const tomb = store.activeTomb();
    await store.enrollPin("48291037");
    store.lock();
    store.prepareGuestUnlock(tomb);
    await store.unlockWithPin("48291037");
    expect(isLocalOnlyGuest()).toBe(true);
    expect(readGuestSessionPerson()?.localOnly).toBe(true);
    store.lock();
  });

  it("keeps connections disabled when the protected guest identity is unavailable", async () => {
    const store = new VaultStore();
    await store.createGuest({ localOnly: true });
    const tomb = store.activeTomb();
    await store.enrollPin("48291037");
    store.lock();
    kvDelete(tombFileKey(tomb, "config/guest-person"));
    store.prepareGuestUnlock(tomb);
    await store.unlockWithPin("48291037");
    expect(isLocalOnlyGuest()).toBe(true);
    expect(readGuestSessionPerson()).toBeNull();
    store.lock();
  });
});
