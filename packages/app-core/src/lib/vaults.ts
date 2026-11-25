/**
 * The vaults on this device, and moving between them (ADR 0089).
 *
 * A device holds several tombs at once: the personal vault, a tomb per
 * project, and the guest tomb a guest session runs in beside a sealed vault.
 * This module is the one view of that set the app renders — the front door
 * before any unlock, the `@tomb` prompt inside a vault, and the Manage panel
 * — so every surface agrees on what a vault is called and what state it is in.
 *
 * Two facts shape it:
 *
 *  - A vault's display name is a secret. It lives in `config/projects` inside
 *    the sealed tomb, so before unlock the only plaintext facts about a
 *    project tomb are its id and its header's `createdAt`. `vaultLabel` says
 *    `project · 4f2a` then, never a leaked name.
 *  - Switching locks the current vault, with one exception: a project sealed
 *    with this session's key (`store.sharesKeyWith`) opens without a prompt.
 *    The row says which it will be before the person commits.
 */

import {
  type OrgVaultRef,
  formatOrgVaultRef,
  parseOrgVaultRef,
} from "@opensesame/os-domain";
import type { VaultHeader } from "@opensesame/vault-core";
import { deadmanBootKeys } from "./deadman/keys.js";
import { guestsAllowed, subscribeGuestAccess } from "./guest-access.js";
import { isGuestVaultId, newGuestVaultId } from "./guest-vault-id.js";
import { kvHydrate } from "./kv.js";
import { readLastVaultId, writeLastVaultId } from "./last-vault.js";
import { guestVaultLabel } from "./local-guest.js";

export { guestVaultLabel } from "./local-guest.js";

import {
  PERSONAL_PROJECT_ID,
  type PagesProject,
  activeProject,
  createProject,
  deleteProject,
  listProjects,
  projectScopedKeys,
  setActiveProject,
  subscribeProjects,
} from "./projects.js";
import { headerCarriesGate } from "./vault/header-gate.js";
import { GUEST_TOMB, readTombHeader, vaultStore } from "./vault/store.js";
import { guestVaultScope } from "./vault/store-scope.js";
import { destroyStoredTomb } from "./vault/store-tomb-destruction.js";
import { StoreWriteQueue } from "./vault/store-write-queue.js";
import {
  type DeviceVault,
  NEW_GUEST_ROAD,
  guestVault,
  protectedGuests,
} from "./vaults-guest.js";
import { listTombs, unregisterTomb } from "./vfs.js";

export type {
  DeviceVault,
  DeviceVaultKind,
  DeviceVaultState,
} from "./vaults-guest.js";
export { NEW_GUEST_ROAD, guestVault } from "./vaults-guest.js";

import {
  migrateLegacyVaultStorage,
  tombStorageKeys,
} from "./vault/tomb-migration.js";

/**
 * What a vault is called on screen. Before unlock a project's name is sealed
 * inside it, so its label is the tomb kind and the tail of its id — enough to
 * tell two apart, and nothing that was ever typed as a name.
 */
export function vaultLabel(project: Pick<PagesProject, "id" | "name">): string {
  if (project.id === PERSONAL_PROJECT_ID) return "personal";
  if (project.id === GUEST_TOMB) return guestVaultLabel();
  if (project.name && project.name !== project.id) return project.name;
  return `project · ${project.id.replace(/^prj_/, "").slice(-4)}`;
}

/**
 * What the open vault is called — the prompt's name for it, so the list's
 * status line and the prompt never disagree (`guest-2` above, `personal:/`
 * below was one vault under two names).
 */
export function openVaultLabel(): string {
  const snapshot = vaultStore.getSnapshot();
  return (snapshot.guest || isGuestVaultId(snapshot.tomb)) && !snapshot.decoy
    ? guestVaultLabel()
    : vaultLabel(activeProject());
}

/**
 * The address a tomb header published, or null when it is missing or does
 * not parse. The header field is plaintext metadata; this re-checks it.
 */
export function publishedAddressOf(
  header: VaultHeader | null,
): OrgVaultRef | null {
  const raw = header?.publishedAddress;
  if (!raw) return null;
  if (raw.ownerKind !== "user" && raw.ownerKind !== "organization") return null;
  const parsed = parseOrgVaultRef(`${raw.owner}/${raw.slug}`, raw.ownerKind);
  return parsed.ok ? parsed.ref : null;
}

/** `owner/slug` for a row that carries an address, else nothing. */
export function vaultAddressLabel(
  vault: Pick<DeviceVault, "address">,
): string | null {
  return vault.address ? formatOrgVaultRef(vault.address) : null;
}

/** `sealed 14 Aug 2026`, or nothing for a tomb that was never sealed. */
export function describeSealedAt(sealedAt: string | null): string | null {
  if (!sealedAt) return null;
  const date = new Date(sealedAt);
  if (Number.isNaN(date.getTime())) return null;
  return `sealed ${date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;
}

function describeVault(project: PagesProject): DeviceVault {
  const snapshot = vaultStore.getSnapshot();
  const header = readTombHeader(project.id);
  // A guest session that happens to run in this tomb (a first-run guest
  // lives in `personal`) is the guest row's to report, not this vault's.
  // A decoy is drawn as the vault the unlock screen was showing: the active one.
  const open =
    snapshot.status === "unlocked" &&
    (snapshot.decoy
      ? project.id === activeProject().id
      : snapshot.tomb === project.id && !snapshot.guest);
  const named = project.name !== project.id;
  const address = publishedAddressOf(header);
  const spelled = address ? formatOrgVaultRef(address) : null;
  return {
    id: project.id,
    kind: project.id === PERSONAL_PROJECT_ID ? "personal" : "project",
    label: spelled && !named ? spelled : vaultLabel(project),
    named,
    sealedAt: header?.createdAt ?? null,
    state: open ? "open" : header ? "locked" : "empty",
    sharedKey: !open && vaultStore.sharesKeyWith(header),
    address,
  };
}

/**
 * Device vaults and the current guest session, without an unused guest road.
 * Guest access remains available on the unlock screen.
 */
function listDeviceVaultsDefault(): DeviceVault[] {
  const snapshot = vaultStore.getSnapshot();
  const guestCurrent = isGuestVaultId(snapshot.tomb) && !snapshot.decoy;
  const protectedRows = protectedGuests().filter(
    (row) => guestsAllowed() || (guestCurrent && row.id === snapshot.tomb),
  );
  const guestRow =
    guestCurrent && !protectedRows.some((row) => row.id === snapshot.tomb)
      ? [
          {
            ...guestVault(snapshot.status === "unlocked" ? "open" : "empty"),
            id: snapshot.tomb ?? GUEST_TOMB,
          },
        ]
      : [];
  return [
    ...listProjects()
      .filter(
        (project) =>
          !isGuestVaultId(project.id) &&
          !(
            guestCurrent &&
            project.id === PERSONAL_PROJECT_ID &&
            !readTombHeader(project.id)
          ),
      )
      .map(describeVault),
    ...protectedRows,
    ...guestRow,
  ];
}

/** Whether the switcher has anything to offer beyond the one vault. */
function deviceHasSeveralVaultsDefault(): boolean {
  return listDeviceVaultsDefault().length > 1;
}

/**
 * The list, for a component: re-derived only when the projects view or the
 * vault store actually emits, not on every render or every keystroke.
 */
let deviceVaultsRevision = 0;
export function subscribeDeviceVaults(listener: () => void): () => void {
  const bump = () => {
    deviceVaultsRevision += 1;
    listener();
  };
  const unsubscribeProjects = subscribeProjects(bump);
  const unsubscribeStore = vaultStore.subscribe(bump);
  const unsubscribeGuestAccess = subscribeGuestAccess(bump);
  return () => {
    unsubscribeProjects();
    unsubscribeStore();
    unsubscribeGuestAccess();
  };
}

/** The version `subscribeDeviceVaults` bumps; React binds it in bindings/vaults.ts. */
export function deviceVaultsVersion(): number {
  return deviceVaultsRevision;
}

/**
 * One vault mutation at a time. A switch yields on durable I/O between
 * choosing a tomb and scoping the store to it, so two switches fired
 * together would interleave and could scope — or fork a header into — the
 * wrong tomb. Every switch/seal/remove verb runs through this chain, and a
 * queued mutation that fails does not poison the next one.
 */
let switchChain: Promise<unknown> = Promise.resolve();

function enqueueVaultMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = switchChain.then(task, task);
  switchChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Bring the active project's keys into this tab and hand the store its
 * scope. `carryKey` is the shared-key road: the store opens the tomb with
 * the key in hand (a new tomb is forked; a sealed one is verified to share
 * the wrap), and anything else falls back to a plain scope swap, which locks.
 */
export async function enterActiveProjectScope(
  carryKey: boolean,
): Promise<void> {
  const tomb = activeProject().id;
  await kvHydrate([...projectScopedKeys(), ...tombStorageKeys(tomb)]);
  await migrateLegacyVaultStorage(tomb);
  if (activeProject().id !== tomb) {
    throw new Error("The active vault changed while switching; try again.");
  }
  // A guest's key was never wrapped to disk: nothing to carry, ever.
  if (
    carryKey &&
    vaultStore.isUnlocked() &&
    !vaultStore.getSnapshot().guest &&
    !isGuestVaultId(vaultStore.getSnapshot().tomb)
  ) {
    if (readTombHeader(tomb)) {
      await vaultStore.openActiveScopeWithCurrentKey();
    } else {
      await vaultStore.forkUnlockedIntoActiveScope();
    }
    return;
  }
  vaultStore.loadActiveProjectScope();
}

export type SwitchOutcome =
  /** Open, no prompt: the vault shared this session's key. */
  | "opened"
  /** The unlock screen for that vault is what comes next. */
  | "locked";

/**
 * Switch to a vault. A shared-key project opens straight away; any other
 * vault locks the current one and lands on its unlock screen, which is the
 * cost the switcher names before the person picks.
 */
async function switchVaultDefault(id: string): Promise<SwitchOutcome> {
  return enqueueVaultMutation(async () => {
    if (
      id === NEW_GUEST_ROAD ||
      (id === GUEST_TOMB && !headerCarriesGate(readTombHeader(id)))
    ) {
      switchToGuestNow();
      // Guest has no enrolled key — UnlockScreen shows a single Unlock button.
      return "locked";
    }
    if (isGuestVaultId(id)) {
      await kvHydrate(tombStorageKeys(id));
      if (vaultStore.isUnlocked()) vaultStore.lock();
      vaultStore.prepareGuestUnlock(id);
      return "locked";
    }
    const target = listProjects().find((project) => project.id === id);
    if (!target) {
      throw new Error("That vault no longer exists on this device.");
    }
    const sharedKey = vaultStore.sharesKeyWith(readTombHeader(id));
    await kvHydrate([...deadmanBootKeys(id)]);
    await setActiveProject(id);
    await enterActiveProjectScope(sharedKey);
    return vaultStore.isUnlocked() ? "opened" : "locked";
  });
}

function switchToGuestNow(): void {
  if (vaultStore.isUnlocked()) vaultStore.lock();
  vaultStore.prepareGuestUnlock(newGuestVaultId());
}

/**
 * The guest road from anywhere: an open vault locks first (a guest never
 * runs beside an open session), then unlock points at the guest tomb.
 * Unlock / Continue-as-guest opens the session. Never gated (AGENTS.md §5).
 */
export async function switchToGuest(): Promise<void> {
  await enqueueVaultMutation(async () => switchToGuestNow());
}

/**
 * Seal a new vault. `shareKey` forks this session's key into it so it opens
 * without a prompt from then on; otherwise it is created empty and its own
 * seal ceremony (passkey, PIN or password) is what comes next.
 */
async function sealNewVaultDefault(
  name: string,
  options: { shareKey: boolean },
): Promise<PagesProject> {
  return enqueueVaultMutation(async () => {
    if (options.shareKey && isGuestVaultId(vaultStore.getSnapshot().tomb))
      throw new Error("A guest vault cannot share its key with another vault.");
    const project = await createProject(name);
    await setActiveProject(project.id);
    await enterActiveProjectScope(options.shareKey);
    return project;
  });
}

/** Remove a vault from this device. Never the personal one, never the open one. */
async function removeVaultDefault(id: string): Promise<void> {
  return enqueueVaultMutation(async () => {
    const snapshot = vaultStore.getSnapshot();
    const openHere =
      snapshot.status === "unlocked" &&
      (snapshot.tomb === id || (id === GUEST_TOMB && snapshot.guest));
    if (openHere) {
      throw new Error("Lock this vault before deleting it.");
    }
    if (isGuestVaultId(id)) {
      if (!listTombs().includes(id) || !headerCarriesGate(readTombHeader(id)))
        throw new Error("That protected guest vault no longer exists.");
      await destroyStoredTomb(new StoreWriteQueue(), guestVaultScope(id));
      await unregisterTomb(id);
      if (readLastVaultId() === id) writeLastVaultId(activeProject().id);
      if (snapshot.tomb === id)
        vaultStore.prepareGuestUnlock(newGuestVaultId());
      return;
    }
    await deleteProject(id);
  });
}

export const vaultsSeams = {
  listDeviceVaults: listDeviceVaultsDefault,
  deviceHasSeveralVaults: deviceHasSeveralVaultsDefault,
  switchVault: switchVaultDefault,
  sealNewVault: sealNewVaultDefault,
  removeVault: removeVaultDefault,
};

export function listDeviceVaults(): DeviceVault[] {
  return vaultsSeams.listDeviceVaults();
}

export function deviceHasSeveralVaults(): boolean {
  return vaultsSeams.deviceHasSeveralVaults();
}

export async function switchVault(id: string): Promise<SwitchOutcome> {
  return vaultsSeams.switchVault(id);
}

export async function sealNewVault(
  name: string,
  options: { shareKey: boolean },
): Promise<PagesProject> {
  return vaultsSeams.sealNewVault(name, options);
}

export async function removeVault(id: string): Promise<void> {
  return vaultsSeams.removeVault(id);
}
