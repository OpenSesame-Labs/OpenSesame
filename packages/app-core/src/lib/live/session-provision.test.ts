import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { readLocalDirectory } from "../local-directory.js";
import { ensureOwnerPerson } from "../local-directory-bootstrap.js";
import { ALL_USERS_GROUP_ID } from "../local-groups.js";
import { localRequestFixture } from "../local-request.fixture.js";
import { listLocalShares } from "../local-share-grants.js";
import { vaultStore } from "../vault/store.js";
import { lockAllTombs } from "../vfs.js";
import {
  provisionLiveSessionGuest,
  sessionProvisionSeams,
} from "./session-provision.js";

describe("session-provision", () => {
  const originalSeams = { ...sessionProvisionSeams };

  beforeEach(() => {
    sessionProvisionSeams.vaultStatus = () => "unlocked";
  });

  afterEach(() => {
    Object.assign(sessionProvisionSeams, originalSeams);
    lockAllTombs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("generates a person and a per-person share for an open session", async () => {
    const fixture = await localRequestFixture();
    sessionProvisionSeams.activeTomb = () => fixture.tomb;
    await provisionLiveSessionGuest({
      tomb: fixture.tomb,
      hostId: crypto.randomUUID(),
      guest: { key: "seat", name: "Ada Lovelace", note: "", kind: "person" },
      scope: { kind: "vault" },
      policy: "read",
      minutes: 60,
      audience: "anyone",
      peopleIds: [],
      items: [],
    });
    const directory = await readLocalDirectory(fixture.tomb);
    const person = directory.entries.find(
      (entry) => entry.kind === "person" && entry.name === "Ada Lovelace",
    );
    expect(person).toBeTruthy();
    const shares = await listLocalShares(fixture.tomb);
    expect(shares).toContainEqual(
      expect.objectContaining({
        principalId: person?.id,
        resourceKind: "vault",
        policy: "open",
      }),
    );
  });

  it("writes an All users share and can match a selected person by claimed name", async () => {
    const fixture = await localRequestFixture();
    sessionProvisionSeams.activeTomb = () => fixture.tomb;
    const groupHost = crypto.randomUUID();
    await provisionLiveSessionGuest({
      tomb: fixture.tomb,
      hostId: groupHost,
      guest: { key: "seat-a", name: "Group Guest", note: "", kind: "person" },
      scope: { kind: "vault" },
      policy: "use",
      minutes: 60,
      audience: "all-users",
      peopleIds: [],
      items: [],
    });
    expect(await listLocalShares(fixture.tomb)).toContainEqual(
      expect.objectContaining({
        principalId: ALL_USERS_GROUP_ID,
        policy: "items",
        sessionId: groupHost,
      }),
    );

    const selected = fixture.personId;
    await provisionLiveSessionGuest({
      tomb: fixture.tomb,
      hostId: crypto.randomUUID(),
      guest: { key: "seat-b", name: "Test person", note: "", kind: "person" },
      scope: { kind: "none" },
      policy: "read",
      minutes: 60,
      audience: "people",
      peopleIds: [selected],
      items: [],
    });
    const directory = await readLocalDirectory(fixture.tomb);
    expect(
      directory.entries.some(
        (entry) => entry.id === selected && entry.name === "Test person",
      ),
    ).toBe(true);
  });

  it("refuses a claimed name that is not on the selected-people list", async () => {
    const fixture = await localRequestFixture();
    sessionProvisionSeams.activeTomb = () => fixture.tomb;
    await expect(
      provisionLiveSessionGuest({
        tomb: fixture.tomb,
        hostId: crypto.randomUUID(),
        guest: { key: "seat", name: "Mallory", note: "", kind: "person" },
        scope: { kind: "none" },
        policy: "read",
        minutes: 60,
        audience: "people",
        peopleIds: [fixture.personId],
        items: [],
      }),
    ).rejects.toThrow(/not on the people selected/);
  });
});

describe("actual", () => {
  const PIN = "48291037";

  beforeEach(async () => {
    vi.stubGlobal("navigator", { locks: webLocksDouble() });
    lockAllTombs();
    await vaultStore.createWithPin(PIN);
  });

  afterEach(() => {
    vaultStore.lock();
    lockAllTombs();
    vi.unstubAllGlobals();
  });

  it("provisions against a real open vault", async () => {
    const tomb = vaultStore.activeTomb();
    await ensureOwnerPerson(tomb, "Owner");
    const item = createItem("secret", "Shared account");
    item.value = "SHARED-SECRET";
    await vaultStore.saveItem(item);
    await provisionLiveSessionGuest({
      tomb,
      hostId: crypto.randomUUID(),
      guest: { key: "seat", name: "Ada", note: "", kind: "person" },
      scope: { kind: "items", ids: [item.id] },
      policy: "use",
      minutes: 60,
      audience: "anyone",
      peopleIds: [],
      items: vaultStore.getSnapshot().items,
    });
    const directory = await readLocalDirectory(tomb);
    expect(
      directory.entries.some(
        (entry) => entry.name === "Ada" && entry.kind === "person",
      ),
    ).toBe(true);
    expect(await listLocalShares(tomb)).toContainEqual(
      expect.objectContaining({ resourceId: item.id, policy: "use" }),
    );
  });
});
