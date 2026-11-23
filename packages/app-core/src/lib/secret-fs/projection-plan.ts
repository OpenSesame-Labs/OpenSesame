/** Plan immutable document names for a vault projection. */
import type { Folder, VaultBody, VaultItem } from "@opensesame/vault-core";
import type { Revision } from "./files.js";
import type { SecretFileName } from "./layout.js";
import {
  type Projected,
  type TombProjection,
  chooseFile,
  kindOf,
} from "./secret-docs.js";

/** What becomes a document: a folder (its directory's marker) or a secret. */
type Subject =
  | Readonly<{
      kind: "folder";
      id: string;
      label: SecretFileName;
      folder: Folder;
    }>
  | Readonly<{
      kind: "item";
      id: string;
      label: SecretFileName;
      item: VaultItem;
    }>;

export type Changed = Readonly<{
  subject: Subject;
  entry: Projected;
  expect: Revision | null;
}>;

/** Folders first, so a secret never takes the name a folder's marker needs. */
function subjects(body: VaultBody): Subject[] {
  const names = new Map(body.folders.map((folder) => [folder.id, folder.name]));
  return [
    ...body.folders.map(
      (folder): Subject => ({
        kind: "folder",
        id: folder.id,
        folder,
        label: {
          folder: folder.name,
          name: "folder",
          kind: "dir",
          id: folder.id,
        },
      }),
    ),
    ...body.items.map(
      (item): Subject => ({
        kind: "item",
        id: item.id,
        item,
        label: {
          folder: item.folderId ? (names.get(item.folderId) ?? null) : null,
          name: item.name,
          kind: kindOf(item),
          id: item.id,
        },
      }),
    ),
  ];
}

type Plan = Readonly<{
  next: Map<string, Projected>;
  changed: Changed[];
}>;

/** Generated versions retain the human-readable folder and base filename. */
const logicalFile = (file: string): string =>
  file.replace(/~v[0-9a-f]{32}(?=\.[^.]+\.json$)/u, "");

function versionedFile(tomb: string, file: string): string {
  const slash = file.lastIndexOf("/");
  const jsonDot = file.lastIndexOf(".json");
  const firstDot = file.lastIndexOf(".", jsonDot - 1);
  const directory = file.slice(0, slash + 1);
  const base = file.slice(slash + 1, firstDot);
  const extension = file.slice(firstDot);
  const suffix = `~v${crypto.randomUUID().replaceAll("-", "")}`;
  const maxBase = Math.min(
    900 - tomb.length - 1 - directory.length - extension.length - suffix.length,
    200 - extension.length - suffix.length,
  );
  if (maxBase >= 1)
    return `${directory}${base.slice(0, maxBase)}${suffix}${extension}`;
  // A path whose folders consume the entire portable bound cannot fit a
  // version beside its label. Keep it immutable at a compact reserved path.
  return `secrets/versions/${crypto.randomUUID().replaceAll("-", "")}${extension}`;
}

/** Decide every document's file, and which of them differ from what is on disk. */
export function plan(
  tomb: string,
  body: VaultBody,
  prev: TombProjection,
  freshFiles: boolean,
): Plan {
  const rev = body.rev ?? 0;
  const claimed = new Set<string>();
  const reserved = new Set(
    [...prev.items.values()].map(
      (entry) => entry.logical ?? logicalFile(entry.file),
    ),
  );
  const next = new Map<string, Projected>();
  const changed: Changed[] = [];
  for (const subject of subjects(body)) {
    const prior = prev.items.get(subject.id);
    const json = JSON.stringify(
      subject.kind === "item" ? subject.item : subject.folder,
    );
    const normalized = prior
      ? { ...prior, file: prior.logical ?? logicalFile(prior.file) }
      : undefined;
    const selected = chooseFile(subject.label, normalized, claimed, reserved);
    if (
      !freshFiles &&
      prior &&
      normalized?.file === selected &&
      prior.json === json
    ) {
      next.set(subject.id, prior);
      claimed.add(selected);
      continue;
    }
    claimed.add(selected);
    // Never replace a document named by the current manifest before the new
    // manifest commits. Competing writers receive separate create-only paths.
    // Every staged document gets an immutable, writer-unique name, including
    // the first generation. If the very first manifest publication has an
    // unknown outcome, a restarted writer must not collide with the orphan it
    // may have left behind at a canonical label-derived path.
    const file = versionedFile(tomb, selected);
    const entry = { file, logical: selected, rev, json };
    next.set(subject.id, entry);
    changed.push({
      subject,
      entry,
      expect: null,
    });
  }
  return { next, changed };
}
