import {
  type VaultHeader,
  createVault,
  emptyBody,
  parseTotp,
  totpCode,
} from "@opensesame/vault-core";
import { describe, expect, it, vi } from "vitest";
import { kvDelete } from "../kv.js";
import {
  LAST_VAULT_KEY,
  readLastVaultId,
  writeLastVaultId,
} from "../last-vault.js";
import { SEAL_BOUND_MARKER_PATH, lockTomb, tombFileKey } from "../vfs.js";
import { defaultPrefs } from "./prefs.js";
import { VaultProtectionBrowserService } from "./protection/browser-service.js";
import { ProtectionSessionGuard } from "./protection/session-guard.js";
import { captureStoreOperation } from "./store-operation-check.js";
import {
  PASSWORD,
  installStoreOperationsFixture,
  newStore,
} from "./store-ops.fixture.js";
import { StorePreferences } from "./store-preferences.js";
import { buildVaultState } from "./store-presentation.js";
import { scopedVaultScope } from "./store-scope.js";
import { enrollTotp } from "./store-totp.fixture.js";
import { StoreUnlockSession } from "./store-unlock-session.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

installStoreOperationsFixture();

const headerStamp: VaultHeader = {
  v: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function presented(open: boolean, pending: boolean) {
  return buildVaultState({
    header: headerStamp,
    open,
    pending,
    ephemeral: false,
    tomb: "personal",
    body: emptyBody(),
    prefs: defaultPrefs,
    attempts: { until: 0, fails: 0 },
  });
}

describe("vault presentation formal replay", () => {
  it("keeps awaitingSecondStep false when the vault is open and a key is still parked", () => {
    const openWithParkedKey = presented(true, true);
    expect(openWithParkedKey.status).toBe("unlocked");
    expect(openWithParkedKey.awaitingSecondStep).toBe(false);
    expect(presented(false, true).awaitingSecondStep).toBe(true);
  });

  it("activate publishes the open snapshot only after the parked key is cleared", async () => {
    const minted = await createVault(PASSWORD);
    minted.rawVaultKey.fill(0);
    const scope = scopedVaultScope();
    const sessionGuard = new ProtectionSessionGuard();
    const preferences = new StorePreferences();
    const previousLast = readLastVaultId();
    let vaultKey: CryptoKey | null = null;
    let parked = true;
    let body = emptyBody();
    const order: string[] = [];
    const published: {
      status: string;
      awaitingSecondStep: boolean;
      open: boolean;
      parked: boolean;
    }[] = [];

    const publish = (kind: string) => {
      order.push(kind);
      const open = vaultKey !== null;
      const snapshot = buildVaultState({
        header: minted.header,
        open,
        pending: parked,
        ephemeral: false,
        tomb: scope.tomb,
        body,
        prefs: preferences.prefs,
        attempts: { until: 0, fails: 0 },
      });
      published.push({
        status: snapshot.status,
        awaitingSecondStep: snapshot.awaitingSecondStep,
        open,
        parked,
      });
    };

    const session = new StoreUnlockSession({
      scope: () => scope,
      original: () =>
        captureStoreOperation(() => ({
          scope,
          session: sessionGuard,
          key: vaultKey,
          raw: null,
          header: minted.header,
        })),
      close: () => {
        vaultKey = null;
        parked = false;
      },
      frozen: () => {},
      clearPending: () => {
        order.push("clear-parked");
        parked = false;
      },
      setKey: (key) => {
        order.push("set-key");
        vaultKey = key;
      },
      loadBody: async () => emptyBody(),
      setBody: (next) => {
        body = next;
      },
      bodyPort: () => ({
        tomb: () => scope.tomb,
        open: () => vaultKey !== null,
        carries: () => false,
        header: () => minted.header,
        body: () => body,
        mutate: async () => {},
        publishKey: async () => {},
      }),
      preferences,
      protection: () =>
        new VaultProtectionBrowserService({
          isGuestOrEphemeral: () => false,
          getHeader: () => minted.header,
          requireRawRoot: () => new Uint8Array(),
          isUnlocked: () => false,
          persistHeader: async () => {},
          replaceRawVaultKey: async () => {},
          withRootWriteTurn: async () => {},
          session: sessionGuard,
        }),
      acquire: async (tomb) => ({ tomb, release: async () => {} }),
      commit: () => {},
      emit: () => publish("publish"),
      completed: () => publish("publish"),
    });

    try {
      // BuggyUnlockOpen starts here: the second step is parked and the vault
      // is not open. activate must clear that key before the store publishes.
      await session.activate(minted.vaultKey);
    } finally {
      lockTomb(scope.tomb);
      kvDelete(tombFileKey(scope.tomb, SEAL_BOUND_MARKER_PATH));
      if (previousLast) writeLastVaultId(previousLast);
      else kvDelete(LAST_VAULT_KEY);
    }

    expect(order).toEqual(["set-key", "clear-parked", "publish"]);
    expect(published).toEqual([
      {
        status: "unlocked",
        awaitingSecondStep: false,
        open: true,
        parked: false,
      },
    ]);
  });

  it("drives the vault store through the counterexample and drops the parked key", async () => {
    const store = newStore();
    expect(store.getSnapshot().status).toBe("empty");
    expect(store.getSnapshot().awaitingSecondStep).toBe(false);

    await store.create(PASSWORD);
    expect(store.getSnapshot().status).toBe("unlocked");
    expect(store.getSnapshot().awaitingSecondStep).toBe(false);

    const uri = await enrollTotp(store);
    const secret = new URL(uri).searchParams.get("secret");
    if (!secret) throw new Error("expected totp secret");
    const selfId = store.getSnapshot().header?.unlocks?.totp?.selfItemId;
    if (!selfId) throw new Error("expected the vault authenticator");
    await store.trashItem(selfId);
    store.lock();
    expect(store.getSnapshot().status).toBe("locked");
    expect(store.getSnapshot().awaitingSecondStep).toBe(false);

    const reopened = newStore();
    await reopened.unlock(PASSWORD);
    expect(reopened.getSnapshot().status).toBe("locked");
    expect(reopened.getSnapshot().awaitingSecondStep).toBe(true);

    await reopened.confirmTotp(await totpCode(parseTotp(secret)));
    expect(reopened.getSnapshot().status).toBe("unlocked");
    expect(reopened.getSnapshot().awaitingSecondStep).toBe(false);
    // The snapshot hides a parked key once the vault is open
    // (awaitingSecondStep is pending && !open). A second confirm reports
    // that nothing is parked.
    await expect(reopened.confirmTotp("000000")).rejects.toThrow(
      "Enter a primary unlock method first.",
    );
  });
});
