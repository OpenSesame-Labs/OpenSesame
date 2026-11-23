import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ProtectionSessionGuard } from "./protection/session-guard.js";
import { captureStoreOperation } from "./store-operation-check.js";
import { StorePreferences } from "./store-preferences.js";
import {
  StoreUnlockSession,
  type UnlockAttempt,
} from "./store-unlock-session.js";

type Action = "begin" | "retain" | "cancel" | "lock" | "switch";
const action = fc.constantFrom<Action>(
  "begin",
  "retain",
  "cancel",
  "lock",
  "switch",
);

/** The real attempt and generation guards with a controlled, in-memory host. */
function harness() {
  let scope = { tomb: "personal", attempts: "attempts.personal" };
  const guard = new ProtectionSessionGuard();
  let closed = 0;
  let published = 0;
  let released = 0;
  let resolveAcquisition: (() => void) | undefined;
  const acquisition = new Promise<void>((resolve) => {
    resolveAcquisition = resolve;
  });
  let session: StoreUnlockSession;
  const lock = () => {
    // VaultStore.lock resets the attempt before invalidating its generation.
    session.reset();
    guard.bump();
  };
  session = new StoreUnlockSession({
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
      closed++;
      lock();
    },
    frozen: () => {},
    clearPending: () => {},
    setKey: () => {
      published++;
    },
    loadBody: async () => {
      throw new Error("Unexpected body load");
    },
    setBody: () => {
      throw new Error("Unexpected body publish");
    },
    setGuestPerson: () => {
      throw new Error("Unexpected guest person");
    },
    bodyPort: () => {
      throw new Error("Unexpected body access");
    },
    preferences: new StorePreferences(),
    protection: () => {
      throw new Error("Unexpected protection access");
    },
    acquire: async (tomb) => {
      await acquisition;
      return {
        tomb,
        release: async () => {
          released++;
        },
      };
    },
    commit: () => {
      throw new Error("Unexpected lease commit");
    },
    emit: () => {},
    completed: () => {
      throw new Error("Unexpected unlock completion");
    },
  });
  return {
    session,
    lock,
    switchScope: () => {
      lock();
      // A new scope is a new object, even when its textual tomb is revisited.
      const tomb = scope.tomb === "personal" ? "other" : "personal";
      scope = { tomb, attempts: `attempts.${tomb}` };
    },
    resolve: () => resolveAcquisition?.(),
    get closed() {
      return closed;
    },
    get published() {
      return published;
    },
    get released() {
      return released;
    },
  };
}

describe("vault unlock attempt lifetime", () => {
  it("never restores a retired attempt through a generated sequence", () => {
    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), (actions) => {
        const host = harness();
        const attempts: UnlockAttempt[] = [];
        let current: UnlockAttempt | null = null;
        for (const next of actions) {
          switch (next) {
            case "begin":
              current = host.session.begin();
              attempts.push(current);
              break;
            case "retain":
              if (current) host.session.retainPrimary(current);
              break;
            case "cancel":
              host.session.cancel();
              current = null;
              break;
            case "lock":
              host.lock();
              current = null;
              break;
            case "switch":
              host.switchScope();
              current = null;
              break;
          }
          for (const attempt of attempts) {
            if (attempt === current)
              expect(() => attempt.check()).not.toThrow();
            else expect(() => attempt.check()).toThrow(/no longer pending/);
          }
          if (current) expect(host.session.current()).toBe(current);
          else
            expect(() => host.session.current()).toThrow(/no longer pending/);
        }
        host.lock();
      }),
      { seed: 0x5a17, numRuns: 250 },
    );
  });

  it("releases a lease that arrives after retirement without touching the replacement", async () => {
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 128 },
      false,
      ["encrypt"],
    );
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<"cancel" | "lock" | "switch" | "begin">(
          "cancel",
          "lock",
          "switch",
          "begin",
        ),
        fc.array(action, { maxLength: 12 }),
        async (retire, actions) => {
          const host = harness();
          let current: UnlockAttempt | null = host.session.begin();
          // Publishing the fixture key before the guard would itself fail the test.
          const pending = expect(
            host.session.activate(key, current),
          ).rejects.toThrow(/no longer pending/);
          const apply = (next: Action) => {
            switch (next) {
              case "begin":
                current = host.session.begin();
                break;
              case "retain":
                if (current) host.session.retainPrimary(current);
                break;
              case "cancel":
                host.session.cancel();
                current = null;
                break;
              case "lock":
                host.lock();
                current = null;
                break;
              case "switch":
                host.switchScope();
                current = null;
                break;
            }
          };
          apply(retire);
          for (const next of actions) apply(next);
          const replacement = host.session.begin();
          const closedBeforeResolution = host.closed;
          host.resolve();
          await pending;
          expect(host.published).toBe(0);
          expect(host.released).toBe(1);
          expect(host.closed).toBe(closedBeforeResolution);
          expect(host.session.current()).toBe(replacement);
          expect(() => replacement.check()).not.toThrow();
          host.lock();
        },
      ),
      { seed: 0x5a18, numRuns: 150 },
    );
  });
});
