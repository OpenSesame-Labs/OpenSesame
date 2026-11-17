import { type SecretItem, createItem } from "@opensesame/vault-core";
import { z } from "zod";
import { guestGithubSessionGuard } from "./github-app-guest-guard.js";
import type { LocalGithubApp } from "./github-app-local.js";
import { vaultStore } from "./vault/store.js";
import { VfsError, readFile, tombFileKey, vfsSeams, writeFile } from "./vfs.js";

const PATH = "config/guest-github-app";
const recordSchema = z.object({
  app: z.object({
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
  }),
  itemId: z.string().min(1),
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
    let value: unknown;
    try {
      value = JSON.parse(item.integration.metadata);
    } catch {
      throw new Error("The guest GitHub App record could not be read.");
    }
    const parsed = recordSchema.shape.app.safeParse(value);
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
  value: unknown,
  check: () => void,
): Promise<Record | null> {
  if (
    typeof value === "object" &&
    value !== null &&
    (("removed" in value && value.removed === true) ||
      Object.keys(value).length === 0)
  ) {
    if (
      "itemId" in value &&
      typeof value.itemId === "string" &&
      "revision" in value &&
      typeof value.revision === "string" &&
      vaultStore
        .getSnapshot()
        .items.some(
          (item) =>
            item.id === value.itemId && item.updatedAt === value.revision,
        )
    ) {
      await vaultStore.purgeItemIfUnchanged(value.itemId, value.revision);
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
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
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
