/**
 * The vault's VFS seams (`vfs-seams.ts`) laid over a secret file store
 * (ADR 0182). Install it and every vault file becomes a real file in whatever
 * the store is — a directory the CLI owns, a privately hosted store a PWA
 * reaches over HTTP, or the emulation in a test — through one code path, so
 * the vault behaves the same on all of them.
 *
 * The VFS reads synchronously and the store answers asynchronously, so the
 * adapter keeps a memory mirror: `hydrate` fills it, every read is answered
 * from it, and every write completes only once the store has the bytes (a
 * failed write leaves the mirror as it was, and the VFS's caller undoes its
 * change). Two kinds of file are not simply mirrored:
 *
 * - the vault **body**, which the VFS thinks of as one sealed blob. It is
 *   taken apart into one document per secret when written (`secret-docs.ts`)
 *   and put back together when the vault opens; the blob exists only in the
 *   mirror. A writer with no key (a flat body from before this layout, a
 *   synced snapshot adopted by a device) is stored as `body.json` and becomes
 *   documents at the next write that has one.
 * - every other file (header, config, index, tomb registry), stored as the
 *   text the VFS gave it at `<tomb>/<path>.json`.
 */
import { Effect } from "effect";
import type { VfsSeams } from "../vfs-seams.js";
import { captureTombEpoch } from "../vfs.js";
import { SETTINGS_DIR, decodeConfig, encodeConfig } from "./config-docs.js";
import { SecretFsRejected } from "./errors.js";
import type { SecretFiles } from "./files.js";
import { captureOwnedBodyFiles } from "./owned-body-files.js";
import { readProjection } from "./projection-read.js";
import { writeProjection } from "./projection-write.js";
import {
  EMPTY_PROJECTION,
  LEGACY_BODY_FILE,
  MANIFEST_FILE,
  type TombProjection,
} from "./secret-docs.js";
import {
  openBodyBlob,
  probeFor,
  sealBodyBlob,
  sealedUnder,
} from "./vfs-body-crypto.js";
import { forgetBodyState, removeBodyFiles } from "./vfs-body-delete.js";
import {
  bodyKey,
  keyOfFile,
  locatable,
  locate,
  rejected,
} from "./vfs-file-keys.js";
import { settle } from "./vfs-files-settle.js";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export type FileBackedVfs = Readonly<{
  /** Load every non-secret file into the mirror. Call once, before the VFS is used. */
  hydrate: () => Promise<void>;
  seams: Required<
    Pick<VfsSeams, "readRaw" | "writeRaw" | "deleteRaw" | "openBody">
  > &
    Pick<VfsSeams, "writeOwnedMetadata" | "writeOwnedBody" | "deleteOwnedFile">;
}>;

/** What one adapter holds: the store, a mirror of its raw files, and what it knows of each vault's documents. */
type Held = Readonly<{
  files: SecretFiles;
  mirror: Map<string, string>;
  projections: Map<string, TombProjection>;
  dirty: Set<string>;
}>;

async function hydrateAll({ files, mirror, projections }: Held): Promise<void> {
  for (const path of await settle(files.list(""))) {
    const found = keyOfFile(path);
    if (found === null) continue;
    const bytes = (await settle(files.read(path))).bytes;
    if (found.flatBody !== null) {
      projections.set(found.flatBody, {
        ...EMPTY_PROJECTION,
        legacyBody: true,
      });
    }
    // A config document names its own VFS path; any other file is the text it is.
    const config = decodeConfig(bytes);
    if (config !== null) {
      const tomb = path.split("/")[0];
      mirror.set(`tomb/${tomb}/${config.path}`, config.value);
    } else if (
      !path.split("/").slice(1).join("/").startsWith(`${SETTINGS_DIR}/`)
    ) {
      mirror.set(found.key, decode(bytes));
    }
  }
}

/** A body written with the vault key becomes documents; the blob stays in the mirror only. */
async function writeKeyedBody(
  held: Held,
  tomb: string,
  value: string,
  vaultKey: CryptoKey,
  protectedFiles?: SecretFiles,
  check?: () => void,
): Promise<void> {
  const { mirror, projections, dirty } = held;
  const files = protectedFiles ?? held.files;
  const prev = projections.get(tomb) ?? EMPTY_PROJECTION;
  check?.();
  const body = await openBodyBlob(tomb, vaultKey, JSON.parse(value));
  check?.();
  // A multi-file root-key rotation needs a durable two-phase publication
  // protocol spanning the body, index, settings and header. This adapter does
  // not claim that guarantee: refusing before the first write is safer than an
  // outage leaving half the vault under each key.
  const sameKey =
    prev.manifestRevision === null || (await sealedUnder(prev, vaultKey));
  check?.();
  if (!sameKey) {
    throw new SecretFsRejected({
      path: `${tomb}/${MANIFEST_FILE}`,
      kind: "unsupported",
      reason:
        "file-backed vault key rotation requires transactional storage support",
    });
  }
  const freshFiles = dirty.has(tomb);
  try {
    const next = await settle(
      writeProjection(files, tomb, vaultKey, body, prev, freshFiles),
    );
    check?.();
    const sealedProbe = await probeFor(vaultKey);
    check?.();
    projections.set(tomb, { ...next, sealedProbe });
    dirty.delete(tomb);
    mirror.set(bodyKey(tomb), value);
  } catch (error) {
    // Preserve the last known revisions. A retry must never reinterpret an
    // existing document as an unconditional new write after partial failure.
    projections.set(tomb, prev);
    dirty.add(tomb);
    throw error;
  }
}

async function writeBody(
  held: Held,
  tomb: string,
  value: string,
  vaultKey: CryptoKey | undefined,
): Promise<void> {
  if (vaultKey !== undefined)
    return writeKeyedBody(held, tomb, value, vaultKey);
  // No key to take the body apart with: keep it flat, to be made documents by
  // the next write that has one.
  const { files, mirror, projections } = held;
  await settle(files.write(`${tomb}/${LEGACY_BODY_FILE}`, encode(value)));
  const prev = projections.get(tomb) ?? EMPTY_PROJECTION;
  projections.set(tomb, { ...prev, legacyBody: true });
  mirror.set(bodyKey(tomb), value);
}

/** Destroying a vault removes every secret's file, not only the ones this process knows of. */
/** Put a vault's body together from its documents and hold it as the blob the VFS reads. */
async function assembleBody(
  { files, mirror, projections, dirty }: Held,
  tomb: string,
  vaultKey: CryptoKey,
  check: () => void,
): Promise<void> {
  check();
  const found = await settle(readProjection(files, tomb, vaultKey));
  check();
  if (found === null) {
    const legacy = await settle(
      files
        .read(`${tomb}/${LEGACY_BODY_FILE}`)
        .pipe(Effect.catchTag("SecretFsNotFound", () => Effect.succeed(null))),
    );
    check();
    if (legacy) {
      mirror.set(bodyKey(tomb), decode(legacy.bytes));
      projections.set(tomb, { ...EMPTY_PROJECTION, legacyBody: true });
    } else {
      mirror.delete(bodyKey(tomb));
      projections.delete(tomb);
    }
    dirty.delete(tomb);
    return;
  }
  if (found.state.legacyBody) {
    // A flat body is also on disk (a write with no key, never retired):
    // whichever is further on is the vault.
    const flat = decode(
      (await settle(files.read(`${tomb}/${LEGACY_BODY_FILE}`))).bytes,
    );
    const flatBody = await openBodyBlob(tomb, vaultKey, JSON.parse(flat));
    check();
    if ((flatBody.rev ?? 0) > (found.body.rev ?? 0)) {
      const sealedProbe = await probeFor(vaultKey);
      check();
      mirror.set(bodyKey(tomb), flat);
      projections.set(tomb, {
        ...found.state,
        legacyBody: true,
        sealedProbe,
      });
      dirty.delete(tomb);
      return;
    }
  }
  const blob = await sealBodyBlob(tomb, vaultKey, found.body);
  const sealedProbe = await probeFor(vaultKey);
  check();
  mirror.set(bodyKey(tomb), JSON.stringify(blob));
  projections.set(tomb, {
    ...found.state,
    sealedProbe,
  });
  dirty.delete(tomb);
}

type Fallback = Pick<VfsSeams, "readRaw" | "deleteRaw"> &
  Partial<Pick<VfsSeams, "deleteRawGuarded" | "deleteOwnedFile">>;
type Serial = <T>(work: () => Promise<T>) => Promise<T>;

function baseFileBackedVfs(
  held: Held,
  fallback: Fallback,
  serial: Serial,
): FileBackedVfs {
  const { files } = held;
  return {
    hydrate: () => serial(() => hydrateAll(held)),
    seams: {
      readRaw: (key) => held.mirror.get(key) ?? fallback.readRaw(key),
      writeRaw: (key, value, vaultKey) =>
        serial(async () => {
          const where = locate(key);
          if (where.kind === "body")
            return writeBody(held, where.tomb, value, vaultKey);
          const doc = encodeConfig(where.path, value);
          await settle(files.write(where.file, doc ?? encode(value)));
          held.mirror.set(key, value);
        }),
      deleteRaw: (key) =>
        serial(async () => {
          const where = locatable(key);
          if (where?.kind === "body") {
            await settle(
              removeBodyFiles(
                files,
                where.tomb,
                held.projections.get(where.tomb)?.manifestRevision ?? null,
              ),
            );
            forgetBodyState(held, where.tomb);
          }
          if (where?.kind === "file") {
            await settle(files.remove(where.file));
            held.mirror.delete(key);
          }
          await fallback.deleteRaw(key);
        }),
      openBody: (tomb, vaultKey, check) => {
        const owner = captureTombEpoch(tomb);
        const active = () => {
          check?.();
          owner();
        };
        return serial(() => assembleBody(held, tomb, vaultKey, active));
      },
    },
  };
}

export function createFileBackedVfs(
  files: SecretFiles,
  fallback: Fallback = {
    readRaw: () => null,
    deleteRaw: () => Promise.resolve(),
    deleteRawGuarded: async (_key, check) => check(),
  },
): FileBackedVfs {
  const held: Held = {
    files,
    mirror: new Map(),
    projections: new Map(),
    dirty: new Set(),
  };
  const guardedWrite = files.writeGuarded?.bind(files);
  const guardedBody = captureOwnedBodyFiles(files);
  const guardedFallback = (
    fallback.deleteOwnedFile ?? fallback.deleteRawGuarded
  )?.bind(fallback);
  // The seams may be called from anywhere, so the adapter orders its own writes.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work, work);
    chain = run.catch(() => undefined);
    return run;
  };

  const adapter = baseFileBackedVfs(held, fallback, serial);
  if (guardedWrite)
    return {
      ...adapter,
      seams: {
        ...adapter.seams,
        writeOwnedMetadata: (key, value, check) =>
          serial(async () => {
            check();
            const where = locate(key);
            if (where.kind === "body")
              throw rejected(key, "has no guarded body projection");
            const doc = encodeConfig(where.path, value);
            await settle(guardedWrite(where.file, doc ?? encode(value), check));
            check();
            held.mirror.set(key, value);
          }),
        ...(guardedBody && {
          writeOwnedBody: (key, value, check, vaultKey) =>
            serial(() => {
              check();
              const where = locate(key);
              if (where.kind !== "body" || !vaultKey)
                throw rejected(key, "requires an unlocked vault body");
              return writeKeyedBody(
                held,
                where.tomb,
                value,
                vaultKey,
                guardedBody(check),
                check,
              );
            }),
        }),
        ...(guardedBody &&
          guardedFallback && {
            deleteOwnedFile: (key, check) =>
              serial(async () => {
                check();
                const where = locate(key);
                const secured = guardedBody(check);
                await settle(
                  where.kind === "body"
                    ? removeBodyFiles(
                        secured,
                        where.tomb,
                        held.projections.get(where.tomb)?.manifestRevision ??
                          null,
                      )
                    : secured.remove(where.file),
                );
                await guardedFallback(key, check);
                check();
                if (where.kind === "body") forgetBodyState(held, where.tomb);
                else held.mirror.delete(key);
              }),
          }),
      },
    };
  return adapter;
}
