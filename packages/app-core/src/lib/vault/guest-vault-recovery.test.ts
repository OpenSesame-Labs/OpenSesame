import { expect, it } from "vitest";
import { newGuestVaultId } from "../guest-vault-id.js";
import { kvGet, kvSet } from "../kv.js";
import {
  BODY_PATH,
  HEADER_PATH,
  listTombs,
  registerPersistedTomb,
  tombFileKey,
} from "../vfs.js";
import { recoverIncompleteGuestVaults } from "./guest-vault-promotion.js";
import { installUnlockRacesFixture } from "./store-unlock-races.fixture.js";
import { acquireOpenLease } from "./vault-shared-locks.js";

installUnlockRacesFixture();

it("recovers only an incomplete promotion whose vault is not open", async () => {
  const tomb = newGuestVaultId();
  const body = tombFileKey(tomb, BODY_PATH);
  const marker = tombFileKey(tomb, "promotion.v1");
  await registerPersistedTomb(
    tomb,
    undefined,
    undefined,
    true,
    crypto.randomUUID(),
  );
  kvSet(marker, JSON.stringify([body]));
  kvSet(body, "encrypted body");
  const release = await acquireOpenLease(tomb);
  await recoverIncompleteGuestVaults([tomb]);
  expect(listTombs()).toContain(tomb);
  expect(kvGet(body)).toBe("encrypted body");
  await release();
  await recoverIncompleteGuestVaults([tomb]);
  expect(listTombs()).not.toContain(tomb);
  expect(kvGet(body)).toBeNull();
  expect(kvGet(marker)).toBeNull();
});

it("preserves a completed or uncertain promotion", async () => {
  const protectedTomb = newGuestVaultId();
  const uncertainTomb = newGuestVaultId();
  await registerPersistedTomb(
    protectedTomb,
    undefined,
    undefined,
    true,
    crypto.randomUUID(),
  );
  await registerPersistedTomb(
    uncertainTomb,
    undefined,
    undefined,
    true,
    crypto.randomUUID(),
  );
  const header = tombFileKey(protectedTomb, HEADER_PATH);
  const marker = tombFileKey(uncertainTomb, "promotion.v1");
  kvSet(header, "protected header");
  kvSet(marker, "invalid recovery record");
  await recoverIncompleteGuestVaults([protectedTomb, uncertainTomb]);
  expect(listTombs()).toEqual(
    expect.arrayContaining([protectedTomb, uncertainTomb]),
  );
  expect(kvGet(header)).toBe("protected header");
  expect(kvGet(marker)).toBe("invalid recovery record");
});
