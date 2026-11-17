/** Journal staged documents and remove obsolete projection files. */
import { Effect } from "effect";
import type { SecretFsError } from "./errors.js";
import type { Revision, SecretFiles } from "./files.js";
import type { Changed } from "./projection-plan.js";
import {
  CONCURRENCY,
  type FolderPayload,
  LEGACY_BODY_FILE,
  type Projected,
  SECRET_FORMAT,
  type SecretPayload,
  type StagingPayload,
  type TombProjection,
  decodeFolderDoc,
  decodeSecretDoc,
  encode,
  folderBinding,
  opened,
  sealed,
  secretBinding,
  stagingBinding,
} from "./secret-docs.js";

type StagingJournal = Readonly<{ path: string; revision: Revision }>;

/** Record exact immutable paths before any document can become an orphan. */
export function beginStaging(
  files: SecretFiles,
  tomb: string,
  key: CryptoKey,
  changed: readonly Changed[],
): Effect.Effect<StagingJournal | null, SecretFsError> {
  if (changed.length === 0) return Effect.succeed(null);
  const attempt = crypto.randomUUID().replaceAll("-", "");
  const path = `${tomb}/staging/${attempt}.json`;
  return Effect.gen(function* () {
    const blob = yield* sealed(
      key,
      {
        v: 1,
        entries: changed.map(({ subject, entry }) => ({
          id: subject.id,
          file: entry.file,
        })),
      },
      stagingBinding(tomb, attempt),
      path,
    );
    const revision = yield* files.write(
      path,
      encode({
        format: SECRET_FORMAT,
        version: 1,
        kind: "projection-stage",
        sealed: blob,
      }),
      { ifRevision: null },
    );
    return { path, revision };
  });
}

function validStaging(payload: StagingPayload): boolean {
  return (
    payload?.v === 1 &&
    Array.isArray(payload.entries) &&
    payload.entries.every(
      (entry) =>
        typeof entry?.id === "string" &&
        typeof entry.file === "string" &&
        /^secrets\/(?:.+~v|versions\/)[0-9a-f]{32}\.[^.]+\.json$/u.test(
          entry.file,
        ),
    )
  );
}

/** Authenticate the exact file named by a sealed staging journal. */
function stagedDocument(
  files: SecretFiles,
  tomb: string,
  key: CryptoKey,
  id: string,
  file: string,
) {
  const path = `${tomb}/${file}`;
  return Effect.gen(function* () {
    const stored = yield* files.read(path);
    const secret = yield* decodeSecretDoc(stored.bytes, path).pipe(
      Effect.flatMap((doc) =>
        opened<SecretPayload>(key, doc.sealed, secretBinding(tomb, id), path),
      ),
      Effect.match({
        onFailure: () => false,
        onSuccess: (payload) => payload.item.id === id,
      }),
    );
    const folder = secret
      ? false
      : yield* decodeFolderDoc(stored.bytes, path).pipe(
          Effect.flatMap((doc) =>
            opened<FolderPayload>(
              key,
              doc.sealed,
              folderBinding(tomb, id),
              path,
            ),
          ),
          Effect.match({
            onFailure: () => false,
            onSuccess: (payload) => payload.folder.id === id,
          }),
        );
    return secret || folder ? { path, revision: stored.revision } : null;
  }).pipe(Effect.catch(() => Effect.succeed(null)));
}

/**
 * Clean only journals observed before this writer's commit. A later writer's
 * journal cannot enter this snapshot, even if it restores the same item id.
 */
function removeStagedForPurgedIds(
  files: SecretFiles,
  tomb: string,
  key: CryptoKey,
  journals: readonly string[],
  kept: ReadonlySet<string>,
  removedIds: ReadonlySet<string>,
): Effect.Effect<void> {
  return Effect.forEach(
    journals,
    (journalPath) =>
      Effect.gen(function* () {
        const stored = yield* files.read(journalPath);
        const filename = journalPath.slice(journalPath.lastIndexOf("/") + 1);
        if (!/^[0-9a-f]{32}\.json$/u.test(filename)) return;
        const attempt = filename.slice(0, -".json".length);
        const doc = yield* decodeSecretDoc(stored.bytes, journalPath);
        const payload = yield* opened<StagingPayload>(
          key,
          doc.sealed,
          stagingBinding(tomb, attempt),
          journalPath,
        );
        if (!validStaging(payload)) return;
        let unresolved = false;
        for (const entry of payload.entries) {
          if (kept.has(entry.file)) continue;
          if (!removedIds.has(entry.id)) {
            unresolved = true;
            continue;
          }
          const candidate = yield* stagedDocument(
            files,
            tomb,
            key,
            entry.id,
            entry.file,
          );
          if (!candidate) continue;
          yield* files
            .remove(candidate.path, { ifRevision: candidate.revision })
            .pipe(
              Effect.catch(() => {
                unresolved = true;
                return Effect.void;
              }),
            );
        }
        if (!unresolved)
          yield* files
            .remove(journalPath, { ifRevision: stored.revision })
            .pipe(Effect.ignore);
      }).pipe(Effect.ignore),
    { concurrency: CONCURRENCY, discard: true },
  );
}

/** Committed: what is left behind past here is clutter, never loss. */
export function removeLeftovers(
  files: SecretFiles,
  tomb: string,
  key: CryptoKey,
  next: ReadonlyMap<string, Projected>,
  prev: TombProjection,
  stagingJournals: readonly string[],
): Effect.Effect<void> {
  const kept = new Set([...next.values()].map((entry) => entry.file));
  const removedIds = new Set(
    [...prev.items.keys()].filter((id) => !next.has(id)),
  );
  const gone = [...prev.items.values()].filter(
    (entry) => !kept.has(entry.file),
  );
  return Effect.gen(function* () {
    yield* Effect.forEach(
      gone,
      (entry) =>
        files
          .remove(
            `${tomb}/${entry.file}`,
            entry.revision === undefined
              ? undefined
              : { ifRevision: entry.revision },
          )
          .pipe(Effect.ignore),
      { concurrency: CONCURRENCY, discard: true },
    );
    if (removedIds.size > 0)
      yield* removeStagedForPurgedIds(
        files,
        tomb,
        key,
        stagingJournals,
        kept,
        removedIds,
      );
    if (prev.legacyBody)
      yield* files.remove(`${tomb}/${LEGACY_BODY_FILE}`).pipe(Effect.ignore);
  });
}
