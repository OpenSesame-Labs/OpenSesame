import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { type SecretItem, createItem } from "@opensesame/vault-core";
import { z } from "zod";
import type { LocalGithubApp } from "./github-app-local.js";
import { captureGuestSessionContext } from "./guest-session-context.js";
import { isGuestVaultId } from "./guest-vault-id.js";
import { readGuestSessionPerson } from "./local-guest.js";
import { dismissNotice, setStatusNotice } from "./notices.js";
import { onVaultLock } from "./vault/lock-events.js";
import { vaultStore } from "./vault/store.js";
import { VfsError, readFile, tombFileKey, vfsSeams, writeFile } from "./vfs.js";

const PATH = "config/guest-github-app";
const appSchema = z.object({
  id: z.string().min(1),
  key: z.string(),
  displayName: z.string(),
  htmlUrl: z.string().nullable(),
  ownerLogin: z.string().nullable(),
  ownerType: z.string().nullable(),
  installedByLogin: z.string().nullable(),
  installations: z.array(
    z.object({
      id: z.string(),
      accountLogin: z.string(),
      accountType: z.string(),
    }),
  ),
});
const recordSchema = z.object({ app: appSchema, itemId: z.string().min(1) });
/** A removal marker an older build left: the item it named may be purged. */
const removalSchema = z.object({
  removed: z.literal(true).optional(),
  itemId: z.string().optional(),
  revision: z.string().optional(),
});
type Record = z.infer<typeof recordSchema>;
const records = new Map<string, Record>();
const PROVIDER = "github-app";

/** Reuse the same item when an interrupted save is retried. */
export function reserveGuestGithubItemId(): string {
  return records.get(vaultStore.activeTomb())?.itemId ?? crypto.randomUUID();
}

function annotatedRecord(): Record | null {
  const items = vaultStore.getSnapshot().items;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      item?.kind !== "secret" ||
      item.deletedAt ||
      item.integration?.provider !== PROVIDER
    )
      continue;
    let metadata: BoundaryValue;
    try {
      metadata = JSON.parse(item.integration.metadata);
    } catch {
      throw new Error("The guest GitHub App record could not be read.");
    }
    const parsed = appSchema.safeParse(metadata);
    if (!parsed.success)
      throw new Error("The guest GitHub App record could not be read.");
    return { app: parsed.data, itemId: item.id };
  }
  return null;
}

/** Save both the key and its public metadata under this guest's own vault key. */
export async function saveGuestGithubApp(
  app: LocalGithubApp,
  secret: string,
  check: () => void,
  itemId = reserveGuestGithubItemId(),
): Promise<void> {
  const guard = guestGithubSessionGuard();
  const tomb = guard.current().tomb;
  const active = () => {
    check();
    guard.current();
  };
  try {
    const prior = vaultStore
      .getSnapshot()
      .items.find(
        (item) =>
          item.id === itemId && item.kind === "secret" && !item.deletedAt,
      );
    const item: SecretItem = {
      ...(prior?.kind === "secret"
        ? prior
        : createItem("secret", app.displayName)),
      id: itemId,
      name: app.displayName,
      value: secret,
      integration: { provider: PROVIDER, metadata: JSON.stringify(app) },
    };
    await vaultStore.saveItems([item], undefined, active);
    active();
    const record = { app, itemId: item.id };
    records.set(tomb, record);
  } finally {
    guard.close();
  }
}

async function recoverLegacyRecord(
  value: BoundaryValue,
  check: () => void,
): Promise<Record | null> {
  const removal = removalSchema.safeParse(value);
  if (
    removal.success &&
    (removal.data.removed === true ||
      (isJsonObject(value) && Object.keys(value).length === 0))
  ) {
    const { itemId, revision } = removal.data;
    if (
      itemId !== undefined &&
      revision !== undefined &&
      vaultStore
        .getSnapshot()
        .items.some((item) => item.id === itemId && item.updatedAt === revision)
    ) {
      await vaultStore.purgeItemIfUnchanged(itemId, revision);
      check();
    }
  } else {
    const parsed = recordSchema.safeParse(value);
    if (!parsed.success)
      throw new Error("The guest GitHub App record could not be read.");
    if (
      vaultStore
        .getSnapshot()
        .items.some(
          (item) =>
            item.id === parsed.data.itemId &&
            item.kind === "secret" &&
            !item.deletedAt,
        )
    )
      return parsed.data;
  }
  return null;
}

export async function loadGuestGithubApp(
  tomb: string,
  check: () => void,
): Promise<LocalGithubApp | null> {
  let legacy: Record | null = null;
  try {
    await vfsSeams.refreshRaw?.(tombFileKey(tomb, PATH), 65536, check);
    check();
    const bytes = await readFile(tomb, PATH);
    check();
    const value: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    legacy = await recoverLegacyRecord(value, check);
  } catch (error) {
    check();
    if (!(error instanceof VfsError && error.code === "not-found")) throw error;
  }
  check();
  const record = annotatedRecord() ?? legacy;
  if (record) records.set(tomb, record);
  else records.delete(tomb);
  return record?.app ?? null;
}

/** Keep verified owner and installation details with the original key binding. */
export async function updateGuestGithubAppMetadata(
  app: LocalGithubApp,
  check: () => void,
): Promise<void> {
  const guard = guestGithubSessionGuard();
  const tomb = guard.current().tomb;
  const record = records.get(tomb);
  try {
    if (!record || record.app.id !== app.id)
      throw new Error("The guest GitHub App record is unavailable. Try again.");
    const active = () => {
      check();
      guard.current();
    };
    active();
    const next = { ...record, app };
    const item = vaultStore
      .getSnapshot()
      .items.find(
        (entry) =>
          entry.id === record.itemId &&
          entry.kind === "secret" &&
          !entry.deletedAt,
      );
    if (item?.kind !== "secret")
      throw new Error("The guest GitHub App key is unavailable. Try again.");
    await vaultStore.saveItems(
      [
        {
          ...item,
          integration: { provider: PROVIDER, metadata: JSON.stringify(app) },
        },
      ],
      undefined,
      active,
    );
    active();
    records.set(tomb, next);
  } finally {
    guard.close();
  }
}

export function guestGithubPem(
  app: { id: string },
  extract: (value: string) => string | null,
): string | null {
  const snapshot = vaultStore.getSnapshot();
  const record = records.get(snapshot.tomb);
  if (!record || record.app.id !== app.id || snapshot.status !== "unlocked")
    return null;
  const item = snapshot.items.find(
    (entry) =>
      entry.id === record.itemId && entry.kind === "secret" && !entry.deletedAt,
  );
  return item?.kind === "secret" ? extract(item.value) : null;
}

export async function removeGuestGithubApp(): Promise<void> {
  const guard = guestGithubSessionGuard();
  const tomb = guard.current().tomb;
  const record = records.get(tomb);
  try {
    const item = vaultStore
      .getSnapshot()
      .items.find((entry) => entry.id === record?.itemId);
    await writeFile(
      tomb,
      PATH,
      new TextEncoder().encode(
        JSON.stringify({
          removed: true,
          itemId: item?.id,
          revision: item?.updatedAt,
        }),
      ),
      () => {
        guard.current();
      },
    );
    guard.current();
    if (item) await vaultStore.purgeItemIfUnchanged(item.id, item.updatedAt);
    guard.current();
    records.delete(tomb);
  } finally {
    guard.close();
  }
}

export function forgetGuestGithubCache(tomb: string): void {
  records.delete(tomb);
}

/** GitHub operations for a guest remain bound to its own vault and actor. */
export function guestGithubSessionGuard() {
  const snapshot = vaultStore.getSnapshot();
  const person = readGuestSessionPerson();
  if (
    snapshot.status !== "unlocked" ||
    snapshot.decoy ||
    !isGuestVaultId(snapshot.tomb) ||
    !person
  )
    throw new Error("Unlock the guest vault first.");
  let ended = false;
  const stop = vaultStore.onLock(() => {
    ended = true;
  });
  return {
    current() {
      const current = vaultStore.getSnapshot();
      if (
        ended ||
        current.status !== "unlocked" ||
        current.decoy ||
        current.tomb !== snapshot.tomb ||
        readGuestSessionPerson()?.id !== person.id
      )
        throw new Error("The guest session ended. Connect again.");
      return current;
    },
    close() {
      ended = true;
      stop();
    },
  };
}

/** Retry a converted GitHub App key while its original guest remains open. */

const ID = "github-app.guest-save";
type Pending = {
  retry: (check: () => void) => Promise<void>;
  owner: () => boolean;
  busy: boolean;
};
let pending: Pending | null = null;

export function clearPendingGuestGithubClaim(): void {
  pending = null;
  dismissNotice(ID);
}
onVaultLock(clearPendingGuestGithubClaim);

function show(): void {
  setStatusNotice({
    id: ID,
    tone: "err",
    title: "GitHub App key not saved",
    body: "GitHub created the App, but its key could not be saved. Keep this vault open and try again.",
    retry: () => {
      void retryPendingGuestGithubClaim();
    },
    transient: true,
  });
}

export function stagePendingGuestGithubClaim(retry: Pending["retry"]): void {
  const owner = captureGuestSessionContext();
  if (!owner?.()) return;
  pending = { retry, owner, busy: false };
  show();
}

export async function retryPendingGuestGithubClaim(): Promise<void> {
  const current = pending;
  if (!current || current.busy) return;
  current.busy = true;
  const check = () => {
    if (pending !== current || !current.owner())
      throw new Error("The guest session ended.");
  };
  try {
    check();
    await current.retry(check);
    check();
    clearPendingGuestGithubClaim();
  } catch {
    if (pending === current && current.owner()) show();
  } finally {
    current.busy = false;
  }
}
