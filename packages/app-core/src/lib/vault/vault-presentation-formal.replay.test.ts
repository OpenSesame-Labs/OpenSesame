import {
  type VaultBody,
  type VaultHeader,
  emptyBody,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { defaultPrefs } from "./prefs.js";
import { ProtectionSessionGuard } from "./protection/session-guard.js";
import { captureStoreOperation } from "./store-operation-check.js";
import { StorePreferences } from "./store-preferences.js";
import { buildVaultState } from "./store-presentation.js";
import {
  StoreUnlockSession,
  type UnlockAttempt,
} from "./store-unlock-session.js";

const header: VaultHeader = {
  v: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

type SessionModel = {
  session: StoreUnlockSession;
  resolveAcquisition: () => void;
  header: boolean;
  open: boolean;
  pending: boolean;
  enrolled: boolean;
  present: () => ReturnType<typeof buildVaultState>;
};

function unlockSessionModel(): SessionModel {
  let headerOnSession = false;
  let open = false;
  let pending = false;
  let enrolled = false;
  const guard = new ProtectionSessionGuard();
  const scope = { tomb: "personal", attempts: "attempts.personal" };
  let resolveAcquisition: (() => void) | undefined;
  const acquisition = new Promise<void>((resolve) => {
    resolveAcquisition = resolve;
  });

  const session = new StoreUnlockSession({
    scope: () => scope,
    original: () =>
      captureStoreOperation(() => ({
        scope,
        session: guard,
        key: null,
        raw: null,
        header: null,
      })),
    close: () => {
      open = false;
      pending = false;
      session.reset();
    },
    frozen: () => {},
    clearPending: () => {
      pending = false;
    },
    setKey: () => {
      open = true;
    },
    loadBody: async () => emptyBody(),
    setBody: () => {},
    setGuestPerson: () => {},
    bodyPort: () => ({
      tomb: () => "personal",
      open: () => true,
      carries: () => true,
      header: () => header,
      body: () => emptyBody(),
      mutate: async (change: (body: VaultBody) => void) => {
        change(emptyBody());
      },
      publishKey: async () => {},
    }),
    preferences: new StorePreferences(),
    protection: () => ({
      ensureProtectionProjected: async () => {},
    }),
    acquire: async (tomb) => {
      await acquisition;
      return {
        tomb,
        release: async () => {},
      };
    },
    commit: () => {},
    emit: () => {},
    completed: () => {},
  });

  return {
    resolveAcquisition: () => resolveAcquisition?.(),
    session,
    get header() {
      return headerOnSession;
    },
    set header(value: boolean) {
      headerOnSession = value;
    },
    get open() {
      return open;
    },
    set open(value: boolean) {
      open = value;
    },
    get pending() {
      return pending;
    },
    set pending(value: boolean) {
      pending = value;
    },
    get enrolled() {
      return enrolled;
    },
    set enrolled(value: boolean) {
      enrolled = value;
    },
    present: () =>
      buildVaultState({
        header: headerOnSession ? header : null,
        open,
        pending,
        ephemeral: false,
        tomb: "personal",
        body: emptyBody(),
        prefs: defaultPrefs,
        attempts: { until: 0, fails: 0 },
      }),
  };
}

/** TLC PrimaryUnlock with second step enrolled: parks the key, vault stays locked. */
function afterPrimaryUnwrap(model: SessionModel, attempt: UnlockAttempt): void {
  attempt.check();
  if (!model.enrolled) throw new Error("Expected enrolled second step");
  model.pending = true;
  model.open = false;
}

describe("vault presentation formal replay", () => {
  it("clears the parked key through StoreUnlockSession.activate before publish", async () => {
    const model = unlockSessionModel();
    model.header = true;
    model.open = true;
    model.enrolled = true;
    model.open = false;

    let view = model.present();
    expect(view.status).toBe("locked");

    model.resolveAcquisition();
    const attempt = model.session.begin();
    afterPrimaryUnwrap(model, attempt);
    view = model.present();
    expect(view.status).toBe("locked");
    expect(view.awaitingSecondStep).toBe(true);

    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    await model.session.activate(key, attempt);
    view = model.present();
    expect(view.status).toBe("unlocked");
    expect(view.awaitingSecondStep).toBe(false);
    expect(view.status === "unlocked" && view.awaitingSecondStep).toBe(false);
  });

  it("does not report awaitingSecondStep while the vault is open", () => {
    const model = unlockSessionModel();
    model.header = true;
    model.pending = true;
    model.open = true;
    const view = model.present();
    expect(view.status).toBe("unlocked");
    expect(view.awaitingSecondStep).toBe(false);
  });
});
