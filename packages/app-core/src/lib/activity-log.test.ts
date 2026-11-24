import { mintVaultKey } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_LOG_PATH,
  activitySeams,
  emitActivity,
  listActivityEvents,
  recordActivityEvent,
} from "./activity-log.js";
import { kvDelete } from "./kv.js";
import {
  INDEX_PATH,
  PERSONAL_TOMB,
  lockAllTombs,
  tombFileKey,
  unlockTomb,
  vfsFlush,
} from "./vfs.js";

describe("activity log", () => {
  beforeEach(async () => {
    await vfsFlush();
    lockAllTombs();
    kvDelete(tombFileKey(PERSONAL_TOMB, ACTIVITY_LOG_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
    activitySeams.activeTomb = () => null;
  });

  it("scrubs a secret a caller left in the summary or the target", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    const rows = await recordActivityEvent(PERSONAL_TOMB, {
      category: "request",
      type: "request.failed",
      summary:
        "claim failed: https://app.example/claim#token=osc_clm_AbC.s3cr3tpart",
      targetType: "claim",
      targetId: "https://x.example/cb?code=abc123",
    });
    expect(JSON.stringify(rows)).not.toMatch(/osc_clm_|s3cr3tpart|abc123/);
    expect(rows[0]?.summary).toContain("claim failed");
  });

  it("seals events under the vault and ignores emit without a tomb", async () => {
    emitActivity({
      category: "settings",
      type: "settings.updated",
      summary: "should not land",
    });
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    const first = await recordActivityEvent(PERSONAL_TOMB, {
      category: "request",
      type: "request.inbound.created",
      summary: "Inbound access request received",
      outcome: "info",
      targetType: "access_request",
      targetId: "req-1",
    });
    expect(first).toHaveLength(1);
    expect(first[0]?.summary).toBe("Inbound access request received");
    activitySeams.activeTomb = () => PERSONAL_TOMB;
    emitActivity({
      category: "settings",
      type: "settings.updated",
      summary: "Settings updated",
      outcome: "succeeded",
    });
    // emitActivity is fire-and-forget: wait for its write to land rather
    // than for a fixed time, which a loaded machine can outlast.
    await vi.waitFor(async () => {
      const listed = await listActivityEvents(PERSONAL_TOMB);
      expect(listed.map((row) => row.type)).toEqual([
        "settings.updated",
        "request.inbound.created",
      ]);
    });
  });

  it("keeps both events from overlapping appends", async () => {
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
    await Promise.all([
      recordActivityEvent(PERSONAL_TOMB, {
        category: "settings",
        type: "settings.updated",
        summary: "First append",
      }),
      recordActivityEvent(PERSONAL_TOMB, {
        category: "vault",
        type: "vault.unlocked",
        summary: "Second append",
      }),
    ]);
    const listed = await listActivityEvents(PERSONAL_TOMB);
    expect(listed.map((row) => row.summary).sort()).toEqual([
      "First append",
      "Second append",
    ]);
  });
});

/**
 * Activity is a log a person reads. An invalidation that fires once per
 * store it touches, fifteen times in a second, was fifteen identical rows.
 */
describe("activity log repeats", () => {
  beforeEach(async () => {
    await vfsFlush();
    lockAllTombs();
    kvDelete(tombFileKey(PERSONAL_TOMB, ACTIVITY_LOG_PATH));
    kvDelete(tombFileKey(PERSONAL_TOMB, INDEX_PATH));
    activitySeams.activeTomb = () => null;
    const { vaultKey } = await mintVaultKey();
    unlockTomb(PERSONAL_TOMB, vaultKey);
  });

  const changed = {
    category: "identity",
    type: "identity.changed",
    summary: "Identity or access state changed",
  } as const;

  it("folds a burst of the same event into one line", async () => {
    for (let index = 0; index < 5; index += 1) {
      await recordActivityEvent(PERSONAL_TOMB, changed);
    }
    const events = await listActivityEvents(PERSONAL_TOMB);
    expect(events.map((event) => event.type)).toEqual(["identity.changed"]);
  });

  it("keeps two different events that start together", async () => {
    await Promise.all([
      recordActivityEvent(PERSONAL_TOMB, changed),
      recordActivityEvent(PERSONAL_TOMB, {
        category: "vault",
        type: "vault.secret.created",
        summary: "A new secret was generated: Deploy key",
        targetType: "secret",
        targetId: "secret-1",
      }),
    ]);
    const events = await listActivityEvents(PERSONAL_TOMB);
    expect(events.map((event) => event.type).sort()).toEqual([
      "identity.changed",
      "vault.secret.created",
    ]);
  });

  it("still folds a burst that starts together", async () => {
    await Promise.all([
      recordActivityEvent(PERSONAL_TOMB, changed),
      recordActivityEvent(PERSONAL_TOMB, changed),
    ]);
    const events = await listActivityEvents(PERSONAL_TOMB);
    expect(events.map((event) => event.type)).toEqual(["identity.changed"]);
  });

  it("keeps a repeat once something else happened between", async () => {
    await recordActivityEvent(PERSONAL_TOMB, changed);
    await recordActivityEvent(PERSONAL_TOMB, {
      category: "settings",
      type: "settings.updated",
      summary: "Settings updated",
    });
    await recordActivityEvent(PERSONAL_TOMB, changed);
    const events = await listActivityEvents(PERSONAL_TOMB);
    expect(events.map((event) => event.type)).toEqual([
      "identity.changed",
      "settings.updated",
      "identity.changed",
    ]);
  });
});
