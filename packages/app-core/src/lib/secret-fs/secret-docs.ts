/**
 * A vault as a directory of sealed documents (ADR 0182). The body the store
 * keeps in memory — every item, the folders, the tombstones — is written as
 * one file per secret plus a manifest:
 *
 *     <tomb>/vault.json                          manifest: rev, folders, item list
 *     <tomb>/secrets/<folder>/<name>.<kind>.json one sealed document per secret
 *
 * Each document is a small declarative envelope (`format`, `version`, `kind`)
 * around a sealed payload, so a person can see what a file is without being
 * able to read it. The seal is the vault's own AES-GCM, bound to the tomb and
 * the item id: a file cannot be opened under another vault, and two secrets'
 * files cannot be swapped for one another. Renaming a file by hand is
 * harmless; the manifest, not the name, says which secret it holds.
 *
 * The manifest is the commit point, written last. Every document records the
 * body revision it was written at, the manifest records the revision each
 * secret should be at, and a read accepts a document that is newer than listed
 * (a write that died before its manifest landed) but never one that is older
 * (a restored copy) or absent.
 */
import {
  type Folder,
  type SealedBlob,
  type VaultBody,
  type VaultItem,
  openJson,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { Effect, Schema } from "effect";
import { z } from "zod";
import { SecretFsRejected } from "./errors.js";
import type { Revision } from "./files.js";
import { type SecretFileName, secretFilePath } from "./layout.js";

export const MANIFEST_FILE = "vault.json";
export const LEGACY_BODY_FILE = "body.json";
export const SECRET_FORMAT = "opensesame.secret";
export const MANIFEST_FORMAT = "opensesame.vault";
export const FOLDER_FORMAT = "opensesame.folder";
export const CONCURRENCY = 8;

const SealedRuntimeSchema = z.object({
  ivB64: z.string(),
  ctB64: z.string(),
});

function sealedSchema() {
  return Schema.Struct({ ivB64: Schema.String, ctB64: Schema.String });
}

function secretSchema() {
  return Schema.Struct({
    format: Schema.Literal(SECRET_FORMAT),
    version: Schema.Literal(1),
    kind: Schema.String,
    sealed: sealedSchema(),
  });
}

function folderSchema() {
  return Schema.Struct({
    format: Schema.Literal(FOLDER_FORMAT),
    version: Schema.Literal(1),
    sealed: sealedSchema(),
  });
}

function manifestSchema() {
  return Schema.Struct({
    format: Schema.Literal(MANIFEST_FORMAT),
    version: Schema.Literal(1),
    sealed: sealedSchema(),
  });
}

/** `spec/secret-files/*.schema.json` is generated from these public schemas. */
export const SecretDoc = /* @__PURE__ */ secretSchema();
export const FolderDoc = /* @__PURE__ */ folderSchema();
export const ManifestDoc = /* @__PURE__ */ manifestSchema();

// Runtime validation has the same input and output contract as the public
// schemas; differential tests hold both readers together.
const RuntimeSecretDoc = z.object({
  format: z.literal(SECRET_FORMAT),
  version: z.literal(1),
  kind: z.string(),
  sealed: SealedRuntimeSchema,
});
const RuntimeFolderDoc = z.object({
  format: z.literal(FOLDER_FORMAT),
  version: z.literal(1),
  sealed: SealedRuntimeSchema,
});
const RuntimeManifestDoc = z.object({
  format: z.literal(MANIFEST_FORMAT),
  version: z.literal(1),
  sealed: SealedRuntimeSchema,
});

export type Listing = {
  id: string;
  file: string;
  rev: number;
  /** Stable label-derived path; `file` is an immutable physical generation. */
  logical?: string;
};
/** A folder is listed like an item; a manifest written before folders were files holds them whole. */
export type ManifestPayload = Omit<VaultBody, "items" | "folders"> & {
  items: Listing[];
  folders: Array<Listing | Folder>;
};
export type FolderPayload = { v: 1; rev: number; folder: Folder };
export type SecretPayload = { v: 1; rev: number; item: VaultItem };
export type StagingPayload = {
  v: 1;
  entries: Array<{ id: string; file: string }>;
};

/** What this process knows is on disk for one vault, so a write sends only what changed. */
export type Projected = Readonly<{
  file: string;
  /** Stable label-derived path, retained when the physical name is truncated. */
  logical?: string;
  rev: number;
  json: string;
  /** The document file's revision as last read or written; the next write must find it so. */
  revision?: Revision | undefined;
}>;
export type TombProjection = Readonly<{
  /** The manifest's revision as last read or written; the next write must find it so. */
  manifestRevision: Revision | null;
  /** Exact committed bytes, retained for conditional rollback after a race. */
  manifestBytes?: Uint8Array;
  items: ReadonlyMap<string, Projected>;
  /** A flat `body.json` from before this layout is still on disk, to be retired. */
  legacyBody: boolean;
  /**
   * A probe sealed under the key the documents were last sealed with. A key
   * that cannot open it is another key (a rotation), and every document is
   * then written again. Keys are compared by what they open, not by identity:
   * the same key is imported more than once in a session.
   */
  sealedProbe?: SealedBlob;
}>;

export const EMPTY_PROJECTION: TombProjection = {
  manifestRevision: null,
  items: new Map(),
  legacyBody: false,
};

export const corrupt = (path: string, reason: string) =>
  new SecretFsRejected({ path, kind: "corrupt", reason });

export const sealed = (
  key: CryptoKey,
  value: ManifestPayload | SecretPayload | FolderPayload | StagingPayload,
  binding: string,
  path: string,
) =>
  Effect.tryPromise({
    try: () => sealJson(key, value, binding),
    catch: () => corrupt(path, "could not be sealed"),
  });

export const opened = <T>(
  key: CryptoKey,
  blob: SealedBlob,
  binding: string,
  path: string,
) =>
  Effect.tryPromise({
    try: () => openJson<T>(key, blob, binding),
    catch: () =>
      corrupt(
        path,
        "does not open under this vault's key: edited, replaced or sealed for another vault",
      ),
  });

type SecretDocBody = typeof SecretDoc.Type;
type ManifestDocBody = typeof ManifestDoc.Type;
type FolderDocBody = typeof FolderDoc.Type;

export const encode = (doc: SecretDocBody | ManifestDocBody | FolderDocBody) =>
  new TextEncoder().encode(`${JSON.stringify(doc, null, 2)}\n`);

const notOfThisFormat = (path: string) => () =>
  corrupt(path, "is not a file of this format");

function decodeDoc<T>(bytes: Uint8Array, path: string, schema: z.ZodType<T>) {
  // Snapshot at construction, as the original schema reader did: callers may
  // clear or reuse the input buffer before they run the returned Effect.
  const text = new TextDecoder().decode(bytes);
  return Effect.try({
    try: () => {
      const result = schema.safeParse(JSON.parse(text));
      if (!result.success) throw new Error("Invalid secret file");
      return result.data;
    },
    catch: notOfThisFormat(path),
  });
}

export const decodeSecretDoc = (bytes: Uint8Array, path: string) =>
  decodeDoc(bytes, path, RuntimeSecretDoc);

export const decodeFolderDoc = (bytes: Uint8Array, path: string) =>
  decodeDoc(bytes, path, RuntimeFolderDoc);

export const decodeManifestDoc = (bytes: Uint8Array, path: string) =>
  decodeDoc(bytes, path, RuntimeManifestDoc);

export const secretBinding = (tomb: string, id: string) =>
  vaultSealBinding(tomb, `secret/${id}`);
export const folderBinding = (tomb: string, id: string) =>
  vaultSealBinding(tomb, `folder/${id}`);
export const stagingBinding = (tomb: string, attempt: string) =>
  vaultSealBinding(tomb, `projection-attempt/${attempt}`);
export const manifestBinding = (tomb: string) =>
  vaultSealBinding(tomb, "manifest");
export const kindOf = (item: VaultItem) =>
  item.kind === "typed" ? item.typeId : item.kind;

/**
 * The file an item keeps: its own if its name still fits it, else a fresh one.
 * A file the committed manifest lists for another secret is never offered, so
 * a document cannot overwrite a file a failed save would leave still listed.
 */
export function chooseFile(
  label: SecretFileName,
  prior: Projected | undefined,
  claimed: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
): string {
  const plain = secretFilePath(label, new Set());
  const suffixed = secretFilePath(label, new Set([plain]));
  const lower = new Set([...claimed].map((path) => path.toLowerCase()));
  if (
    prior &&
    (prior.file === plain || prior.file === suffixed) &&
    !lower.has(prior.file.toLowerCase())
  ) {
    return prior.file;
  }
  const others = [...reserved].filter((file) => file !== prior?.file);
  return secretFilePath(label, new Set([...claimed, ...others]));
}
