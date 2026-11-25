import { createVault } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setGuestsAllowed } from "./guest-access.js";
import { guestAuthSeams } from "./guest-auth.js";
import { kvDelete, kvDeleteDurable, kvSet } from "./kv.js";
import {
  clearGuestSessionPerson,
  mintGuestSessionPerson,
} from "./local-guest.js";
import {
  PERSONAL_PROJECT_ID,
  type ProjectsState,
  projectSeams,
} from "./projects.js";
import { GUEST_TOMB, vaultStore } from "./vault/store.js";
import {
  describeSealedAt,
  deviceHasSeveralVaults,
  enterActiveProjectScope,
  listDeviceVaults,
  openVaultLabel,
  removeVault,
  subscribeDeviceVaults,
  switchVault,
  vaultLabel,
} from "./vaults.js";
import {
  HEADER_PATH,
  PERSONAL_TOMB,
  registerTomb,
  tombFileKey,
  unregisterTomb,
} from "./vfs.js";

const PASSWORD = "correct horse battery staple";

const state: ProjectsState = {
  v: 1,
  projects: [
    {
      id: PERSONAL_PROJECT_ID,
      name: "Personal",
      kind: "personal",
      createdAt: "2025-01-01T00:00:00Z",
    },
    // Pre-unlock: the boot view names a project by its id.
    {
      id: "prj_1234abcd-0000-0000-0000-00000000f4a2",
      name: "prj_1234abcd-0000-0000-0000-00000000f4a2",
      kind: "standard",
      createdAt: "2025-01-02T00:00:00Z",
    },
    {
      id: "prj_named",
      name: "Work",
      kind: "standard",
      createdAt: "2025-01-03T00:00:00Z",
    },
  ],
  activeId: PERSONAL_PROJECT_ID,
};

const originalProjectSeams = { ...projectSeams };
const originalGuestSeams = { ...guestAuthSeams };

beforeEach(async () => {
  Object.assign(projectSeams, {
    projectsState: () => state,
    subscribeProjects: () => () => {},
    activeProject: () => state.projects[0],
  });
  kvDelete(tombFileKey(PERSONAL_TOMB, HEADER_PATH));
  kvDelete(tombFileKey("prj_named", HEADER_PATH));
  await kvDeleteDurable(tombFileKey(GUEST_TOMB, HEADER_PATH));
  clearGuestSessionPerson();
  vaultStore.loadActiveProjectScope();
});

afterEach(() => {
  Object.assign(projectSeams, originalProjectSeams);
  Object.assign(guestAuthSeams, originalGuestSeams);
  vaultStore.lock();
  clearGuestSessionPerson();
});

describe("vaultLabel — honest before unlock", () => {
  it("never shows a sealed name it does not have", () => {
    expect(vaultLabel({ id: PERSONAL_PROJECT_ID, name: "Personal" })).toBe(
      "personal",
    );
    expect(
      vaultLabel({
        id: "prj_1234abcd-0000-0000-0000-00000000f4a2",
        name: "prj_1234abcd-0000-0000-0000-00000000f4a2",
      }),
    ).toBe("project · f4a2");
    expect(vaultLabel({ id: "prj_named", name: "Work" })).toBe("Work");
    expect(vaultLabel({ id: GUEST_TOMB, name: GUEST_TOMB })).toBe("guest");
  });

  it("uses the guest-N slug once a guest session exists", () => {
    mintGuestSessionPerson();
    expect(vaultLabel({ id: GUEST_TOMB, name: GUEST_TOMB })).toBe("guest-1");
  });
});

describe("describeSealedAt", () => {
  it("says when, or nothing", () => {
    expect(describeSealedAt(null)).toBeNull();
    expect(describeSealedAt("not a date")).toBeNull();
    const text = describeSealedAt("2026-08-14T10:00:00Z");
    expect(text).toMatch(/^sealed /);
    expect(text).toContain("2026");
  });
});

describe("listDeviceVaults", () => {
  it("lists only device vaults, not an unused guest session", async () => {
    const { header } = await createVault(PASSWORD);
    kvSet(tombFileKey("prj_named", HEADER_PATH), JSON.stringify(header));

    const vaults = listDeviceVaults();
    expect(vaults.map((vault) => vault.id)).toEqual([
      PERSONAL_PROJECT_ID,
      "prj_1234abcd-0000-0000-0000-00000000f4a2",
      "prj_named",
    ]);
    const [personal, unnamed, work] = vaults;
    expect(personal?.state).toBe("empty");
    expect(unnamed?.named).toBe(false);
    expect(unnamed?.label).toBe("project · f4a2");
    expect(work?.state).toBe("locked");
    expect(work?.sealedAt).toBe(header.createdAt);
    expect(work?.sharedKey).toBe(false);
    expect(work?.address).toBeNull();
  });

  it("shows just the personal vault after it is sealed", async () => {
    Object.assign(projectSeams, {
      projectsState: () => ({ ...state, projects: [state.projects[0]] }),
    });
    const { header } = await createVault(PASSWORD);
    kvSet(tombFileKey(PERSONAL_TOMB, HEADER_PATH), JSON.stringify(header));
    expect(listDeviceVaults().map((vault) => vault.id)).toEqual([
      PERSONAL_PROJECT_ID,
    ]);
  });

  it("shows owner/slug from the tomb header and keeps a sealed name", async () => {
    const { header } = await createVault(PASSWORD);
    kvSet(
      tombFileKey("prj_named", HEADER_PATH),
      JSON.stringify({
        ...header,
        publishedAddress: {
          ownerKind: "organization",
          owner: "acme",
          slug: "ledger",
        },
      }),
    );
    kvSet(
      tombFileKey(PERSONAL_TOMB, HEADER_PATH),
      JSON.stringify({
        ...header,
        publishedAddress: { ownerKind: "user", owner: "ada", slug: "personal" },
      }),
    );
    const vaults = listDeviceVaults();
    const personal = vaults.find((vault) => vault.id === PERSONAL_PROJECT_ID);
    const work = vaults.find((vault) => vault.id === "prj_named");
    const unnamed = vaults.find((vault) => vault.id.endsWith("f4a2"));
    expect(personal?.label).toBe("personal");
    expect(personal?.address).toEqual({
      ownerKind: "user",
      owner: "ada",
      slug: "personal",
    });
    expect(work?.label).toBe("Work");
    expect(work?.address).toEqual({
      ownerKind: "organization",
      owner: "acme",
      slug: "ledger",
    });
    expect(unnamed?.address).toBeNull();
    expect(unnamed?.label).toBe("project · f4a2");
    expect(JSON.stringify(work)).not.toContain(PASSWORD);
  });

  it("ignores a published address that does not parse", async () => {
    const { header } = await createVault(PASSWORD);
    kvSet(
      tombFileKey("prj_named", HEADER_PATH),
      JSON.stringify({
        ...header,
        publishedAddress: {
          ownerKind: "user",
          owner: "Guest",
          slug: "personal",
        },
      }),
    );
    const work = listDeviceVaults().find((vault) => vault.id === "prj_named");
    expect(work?.address).toBeNull();
    expect(work?.label).toBe("Work");
  });

  it("removes an ephemeral guest row when the session ends", async () => {
    await vaultStore.createGuest();
    const id = vaultStore.activeTomb();
    vaultStore.lock();
    const vaults = listDeviceVaults();
    const guests = vaults.filter((vault) => vault.id === id);
    expect(guests).toHaveLength(0);
  });

  it("keeps a sealed guest vault available after switching away", async () => {
    Object.assign(projectSeams, {
      projectsState: () => ({ ...state, projects: [state.projects[0]] }),
    });
    const { header } = await createVault(PASSWORD);
    kvSet(tombFileKey(GUEST_TOMB, HEADER_PATH), JSON.stringify(header));
    await registerTomb(GUEST_TOMB);
    try {
      const guest = listDeviceVaults().find((vault) => vault.id === GUEST_TOMB);
      expect(guest).toMatchObject({
        state: "locked",
        sealedAt: header.createdAt,
        sharedKey: false,
      });
      expect(deviceHasSeveralVaults()).toBe(true);
      await setGuestsAllowed(false);
      try {
        expect(
          listDeviceVaults().some((vault) => vault.id === GUEST_TOMB),
        ).toBe(false);
        expect(deviceHasSeveralVaults()).toBe(false);
      } finally {
        await setGuestsAllowed(true);
      }
    } finally {
      await unregisterTomb(GUEST_TOMB);
    }
  });

  it("notifies vault lists when guest access changes", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDeviceVaults(listener);
    try {
      await setGuestsAllowed(false);
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      await setGuestsAllowed(true);
    }
  });

  it("marks the guest row open while a guest session runs — never the tomb it borrows", async () => {
    await vaultStore.createGuest();
    const id = vaultStore.activeTomb();
    const vaults = listDeviceVaults();
    const guest = vaults.at(-1);
    expect(guest?.id).toBe(id);
    expect(guest?.state).toBe("open");
    // An unsealed personal placeholder is not a second vault.
    expect(vaults.some((vault) => vault.id === PERSONAL_PROJECT_ID)).toBe(
      false,
    );
  });
});

describe("a duress decoy in the list", () => {
  it("is the open vault the unlock screen showed, never the guest row", async () => {
    await vaultStore.createGuest({ decoy: true });
    const snapshot = vaultStore.getSnapshot();
    expect(snapshot.guest).toBe(true);
    expect(snapshot.decoy).toBe(true);
    const vaults = listDeviceVaults();
    expect(vaults[0]?.id).toBe(PERSONAL_PROJECT_ID);
    expect(vaults[0]?.state).toBe("open");
    expect(vaults.some((vault) => vault.id === GUEST_TOMB)).toBe(false);
    expect(openVaultLabel()).toBe("personal");
    vaultStore.lock();
  });

  it("leaves an ordinary guest as the guest row", async () => {
    await vaultStore.createGuest();
    expect(vaultStore.getSnapshot().decoy).toBe(false);
    expect(openVaultLabel()).toMatch(/^guest(?:-[1-9]\d*)?$/);
    vaultStore.lock();
  });
});

describe("switchVault", () => {
  it("returns to an existing guest vault using its enrolled PIN", async () => {
    await vaultStore.createGuest();
    const id = vaultStore.activeTomb();
    await vaultStore.enrollPin("24681357");
    expect(listDeviceVaults().filter((vault) => vault.id === id)).toMatchObject(
      [{ state: "open" }],
    );
    vaultStore.lock();
    vaultStore.loadActiveProjectScope();

    expect(listDeviceVaults().filter((vault) => vault.id === id)).toMatchObject(
      [{ state: "locked" }],
    );
    await expect(switchVault(id)).resolves.toBe("locked");
    expect(vaultStore.getSnapshot().header?.unlocks?.pin).toBeDefined();
    await vaultStore.unlockWithPin("24681357");
    expect(vaultStore.getSnapshot()).toMatchObject({
      tomb: id,
      status: "unlocked",
    });
    expect(openVaultLabel()).toMatch(/^guest(?:-[1-9]\d*)?$/);
  });

  it("the guest road locks the open vault and lands on guest Unlock", async () => {
    await vaultStore.createWithPin("24681357");
    expect(vaultStore.isUnlocked()).toBe(true);
    await expect(switchVault(GUEST_TOMB)).resolves.toBe("locked");
    const snap = vaultStore.getSnapshot();
    expect(snap.tomb).toMatch(/^guest_[0-9a-f-]{36}$/);
    expect(snap.status).toBe("empty");
    expect(vaultStore.isUnlocked()).toBe(false);
  });

  it("refuses a vault that is not on this device", async () => {
    await expect(switchVault("prj_ghost")).rejects.toThrow(/no longer exists/);
  });

  it("runs a second switch only after the first settles", async () => {
    let activeId = PERSONAL_PROJECT_ID;
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let held = true;
    Object.assign(projectSeams, {
      activeProject: () =>
        state.projects.find((project) => project.id === activeId) ??
        state.projects[0],
      setActiveProject: async (id: string) => {
        order.push(`begin:${id}`);
        if (held) {
          held = false;
          await firstGate;
        }
        activeId = id;
        order.push(`end:${id}`);
      },
    });
    const first = switchVault("prj_named");
    await vi.waitFor(() => expect(order).toEqual(["begin:prj_named"]));
    const second = switchVault(PERSONAL_PROJECT_ID);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["begin:prj_named"]);
    releaseFirst();
    await expect(first).resolves.toBe("locked");
    await expect(second).resolves.toBe("locked");
    expect(order).toEqual([
      "begin:prj_named",
      "end:prj_named",
      "begin:personal",
      "end:personal",
    ]);
  });

  it("enterActiveProjectScope throws when the active vault moved mid-flight", async () => {
    let activeId = PERSONAL_PROJECT_ID;
    Object.assign(projectSeams, {
      activeProject: () =>
        state.projects.find((project) => project.id === activeId) ??
        state.projects[0],
    });
    const pending = enterActiveProjectScope(false);
    activeId = "prj_named";
    await expect(pending).rejects.toThrow(/changed while switching/);
  });
});

describe("removeVault", () => {
  it("never deletes the vault that is open", async () => {
    await vaultStore.createGuest();
    await expect(removeVault(GUEST_TOMB)).rejects.toThrow(/Lock this vault/);
  });
});
